/**
 * 超管在到货通知里改「已转正式运单」的那条（2026-10-16 老板「让超管在到货通知里也能改」）—— 不连库。
 *
 * 一、converted-edit.ts 的几个函数直接调：只发改过的项、产品行带原来的行号、总数按「运单管理」的裁决、乱填的数字拦住。
 * 二、真把弹窗（NoticeEditor）跑起来（同 test-arrival-notice-editor.ts 的假 React），接口全换成桩，核对：
 *     先重读运单 → 一样才走超管改单那条路 → 再刷新卡片和备注；别人改过就不存；只改备注不碰运单；整柜的不给存……
 * 三、卡片（NoticeCard）：已转正式运单只有 canEditConverted（后端按超管给）才出「修改」。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import { buildAdminOrderPatch, convertedDraftIssue, convertedTotals, sameConvertedDraft } from "../apps/web/src/modules/arrival-notice/converted-edit";
import { convertedDraftOf } from "../apps/web/src/modules/arrival-notice/draft";

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); console.log(`✅ ${name}`); }
  catch (e) { failures += 1; console.log(`❌ ${name}\n   ${(e instanceof Error ? e.stack ?? e.message : String(e)).split("\n").slice(0, 6).join("\n   ")}`); }
}

/* ───────────── 夹具：一票已转正式运单（运单现在的样子） ───────────── */
const P1 = { itemName: "冰敷袋", packageCount: 2, lengthCm: 42, widthCm: 42, heightCm: 41, weightKg: 13, productQuantity: null, cargoType: "normal", domesticTrackingNo: "S665" };
const P2 = { itemName: "冰敷袋", packageCount: 1, lengthCm: 38, widthCm: 37.5, heightCm: 38, weightKg: 7, productQuantity: null, cargoType: "normal", domesticTrackingNo: null };
function makeDetail(over: Record<string, unknown> = {}, products: any[] = [P1, P2], productIds = ["op1", "op2"], blockedReason: string | null = null) {
  return {
    item: {
      id: "zz-conv", clientId: "ZZA01", trackingNo: "YW0001734", products, itemName: "冰敷袋", packageCount: 3,
      weightKg: 33, volumeM3: 0.199, transportMode: "sea", cargoType: null, domesticTrackingNo: "S665",
      warehouseId: "wh_yiwu_01", arrivedAt: "2026-10-16", remark: "内部备注", notifiedAt: null, notifiedByName: null,
      convertedTo: "formal", shipmentId: "ship1", shipmentStatus: "inWarehouseCN", shipmentGone: false, canEditConverted: true,
      convertedAt: "2026-10-16T09:51:50.000Z", createdByName: null, createdAt: "2026-10-16T09:00:00.000Z", updatedAt: "2026-10-16T09:51:50.000Z",
      images: [{ id: "img1", fileName: "a.jpg", imageUrl: "/images/a.jpg", thumbUrl: "/images/a.jpg" }], prealertMatches: [],
      ...over,
    },
    orderId: "o1", shipmentId: "ship1", orderUpdatedAt: "2026-10-16T09:51:50.000Z", productIds, blockedReason,
  } as any;
}

/* ───────────── 二、假 React 把弹窗跑起来（同 test-arrival-notice-editor.ts） ───────────── */
let hooks: any[] = [], index = 0, effects: Array<() => void> = [], dirty = false, tree: any;
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
  useCallback(fn: any) { index++; return fn; },
  useLayoutEffect() { index++; },
};
(globalThis as any).window = { setTimeout, clearTimeout, confirm: () => true, localStorage: { getItem: () => null, setItem() {} } };

let calls: string[] = [];
let freshDetail: any = null;
let patches: any[] = [];
let refreshRemarks: Array<string | null> = [];
let refreshExpected: Array<string | null> = [];
let refreshFail = false;
let refreshNotifiedAt: string | null = null;
let updateFail: string | null = null;
/** 整页测试（G*）：按到货通知 id 挂起的详情请求，测试自己决定先回哪个 */
const pendingDetails = new Map<string, { resolve: (v: any) => void; reject: (e: unknown) => void }>();
let deferDetails = false;
let listItems: any[] = [];
/** 整页测试：客户名单接口（/staff/clients）回什么（G4 用；别的测试回空） */
let staffClientsMock: any[] = [];
/** G4b：客户名单请求挂起在这里，测试按需要的顺序放 */
let clientsDeferred: Array<(v: any) => void> | null = null;
/** 页面订的推送：分类 → 收到时调的函数 */
const liveRefresh = new Map<string, () => unknown>();
const runtime = { jsx: (type: any, p: any, key: any) => ({ type, props: p, key }), jsxs: (type: any, p: any, key: any) => ({ type, props: p, key }) };
const file = path.resolve("apps/web/src/modules/arrival-notice/ArrivalNoticesView.tsx");
const realRequire = createRequire(file);
const out = ts.transpileModule(fs.readFileSync(file, "utf8") + "\nexport { NoticeEditor, NoticeCard };", {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: file,
}).outputText;
const mod = { exports: {} as any };
new Function("exports", "require", "module", out)(mod.exports, (id: string) => {
  if (id === "react") return fakeReact;
  if (id === "react/jsx-runtime") return runtime;
  const real = realRequire(id);
  if (id === "../../services/arrival-notice-api") {
    return {
      ...real,
      fetchConvertedNoticeDetail: async (id: string) => {
        calls.push("fetch");
        if (deferDetails) return new Promise((resolve, reject) => pendingDetails.set(id, { resolve, reject }));
        return freshDetail;
      },
      fetchArrivalNotices: async () => ({ items: listItems, total: listItems.length, page: 1, pageSize: 30, counts: { todo: 0, notified: 0, inbound: 0, formal: listItems.length, all: listItems.length } }),
      refreshConvertedNotice: async (_id: string, remark?: { value: string; expected: string }) => {
        calls.push("refresh"); refreshRemarks.push(remark ? remark.value : null); refreshExpected.push(remark ? remark.expected : null);
        if (refreshFail) throw new Error("网断了");
        return { item: { ...freshDetail.item, remark: remark ? remark.value : freshDetail.item.remark, notifiedAt: refreshNotifiedAt } };
      },
      saveArrivalNotice: async () => { calls.push("save-notice"); throw new Error("已转正式运单不该走到货通知自己的保存"); },
    };
  }
  if (id === "../../services/business-api") {
    return { ...real, fetchStaffClients: async () => {
      // G4b：按顺序挂起，测试自己决定先回哪个（制造「旧请求晚回来」）
      if (clientsDeferred) return new Promise((resolve) => clientsDeferred!.push(resolve));
      if (!staffClientsMock) throw new Error("网断了"); return staffClientsMock;
    }, updateAdminOrder: async (patch: any) => { calls.push("update"); patches.push(patch); if (updateFail) throw new Error(updateFail); return { orderId: "o1" }; } };
  }
  // 记下页面订了哪几类推送、收到时调什么（G4 用来模拟「账号」推送）
  if (id === "../realtime/useRealtime") return { useLiveRefresh(o: any) { liveRefresh.set([...o.topics].sort().join(","), o.refresh); } };
  return real;
}, mod);

let props: any; let savedMessage: string | null = null;
function flush() {
  for (let n = 0; n < 30; n++) {
    index = 0; dirty = false; tree = mod.exports.NoticeEditor(props);
    const queue = effects; effects = []; queue.forEach((fn) => fn());
    if (!dirty) return;
  }
  throw new Error("无限重画");
}
function nodes(test: (n: any) => boolean, root = tree): any[] {
  if (!root || typeof root !== "object") return [];
  if (Array.isArray(root)) return root.flatMap((n) => nodes(test, n));
  return [...(test(root) ? [root] : []), ...nodes(test, root.props?.children ?? null)];
}
function text(n: any): string {
  if (n == null || typeof n === "boolean") return "";
  if (Array.isArray(n)) return n.map(text).join("");
  return typeof n === "object" ? text(n.props?.children) : String(n);
}
function field(label: string, root = tree): any {
  const l = nodes((n) => n.type === "label" && text(n).startsWith(label), root)[0];
  assert.ok(l, `找不到 ${label}`);
  return nodes((n) => n.type === "input" || n.type === "textarea" || n.type === "select", l)[0];
}
function change(label: string, value: string, root = tree) { field(label, root).props.onChange({ target: { value } }); flush(); }
function button(label: string): any { return nodes((n) => n.type === "button" && text(n) === label)[0]; }
function mountConverted(detail: any, fresh: any = detail) {
  hooks = []; effects = []; calls = []; patches = []; refreshRemarks = []; refreshExpected = []; refreshFail = false; refreshNotifiedAt = null; updateFail = null; savedMessage = null;
  freshDetail = fresh;
  props = {
    editor: { mode: "converted", item: detail.item, detail, seq: 1 },
    clients: [{ id: "ZZA01" }, { id: "ZZB02" }], bannedClients: new Set(), clientsFailed: false,
    onClose() {}, onChanged: async () => {}, onSaved(m: string) { savedMessage = m; },
  };
  flush();
}
async function save() {
  const b = button("保存");
  assert.ok(b, "找不到保存按钮");
  await b.props.onClick();
  await new Promise<void>((r) => setImmediate(r)); flush();
}
const errorText = () => text(nodes((n) => n.props?.role === "alert"));

/* 整页（ArrivalNoticesView）跑起来：卡片、弹窗都是元素（不往下渲染），从元素的 props 里拿 onEdit、看开的是哪个弹窗 */
let viewTree: any;
function renderView() {
  for (let n = 0; n < 30; n++) {
    index = 0; dirty = false; viewTree = mod.exports.default({});
    const queue = effects; effects = []; queue.forEach((fn) => fn());
    if (!dirty) return;
  }
  throw new Error("整页无限重画");
}
const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise<void>((r) => setImmediate(r)); renderView(); } };
const cards = () => nodes((n) => n.type === mod.exports.NoticeCard, viewTree);
const openedEditor = () => nodes((n) => n.type === mod.exports.NoticeEditor, viewTree)[0]?.props.editor ?? null;
const errorToasts = () => nodes((n) => n.props?.tone === "error" && n.props?.open, viewTree).map((n) => n.props.message);
async function mountView(items: any[]) {
  hooks = []; effects = []; calls = []; pendingDetails.clear(); deferDetails = true; listItems = items;
  renderView(); await settle();
}

async function main(): Promise<void> {
  console.log("超管改已转正式运单（不连库）");

  /* ───────────── 一、纯函数 ───────────── */
  await check("F1 什么都没改：不碰运单（changed=false）；草稿带上原来的产品行号", () => {
    const base = convertedDraftOf(makeDetail());
    assert.deepEqual(base.products.map((p) => p.orderProductId), ["op1", "op2"]);
    const { patch, changed } = buildAdminOrderPatch("ship1", base, { ...base, remark: "只改备注" });
    assert.equal(changed, false, JSON.stringify(patch));
    assert.deepEqual(patch, { orderId: "ship1" });
  });

  await check("F2 只改了仓库 / 到仓日期：只发那两项（不发产品、不发总数）", () => {
    const base = convertedDraftOf(makeDetail());
    const { patch, changed } = buildAdminOrderPatch("ship1", base, { ...base, warehouseId: "wh_guangzhou_01", arrivedAt: "2026-10-15" });
    assert.equal(changed, true);
    assert.deepEqual(patch, { orderId: "ship1", warehouseId: "wh_guangzhou_01", shipDate: "2026-10-15" });
  });

  await check("F3 改了一款的件数：产品整份发、带原来的行号；件数合计、品名、总数（按产品行算）一起发；订单那一格国内单号不发", () => {
    const base = convertedDraftOf(makeDetail());
    const draft = { ...base, products: base.products.map((p, i) => (i === 1 ? { ...p, packageCount: "3" } : p)) };
    const { patch } = buildAdminOrderPatch("ship1", base, draft);
    assert.deepEqual(patch.products!.map((p) => p.id), ["op1", "op2"]);
    assert.deepEqual(patch.products!.map((p) => p.packageCount), [2, 3]);
    assert.equal(patch.products![1].domesticTrackingNo, "货拉拉", "空着的国内单号写「货拉拉」（同创建订单 / 运单管理）");
    assert.equal(patch.packageCount, 5);
    assert.equal(patch.itemName, "冰敷袋");
    assert.equal((patch as any).domesticTrackingNo, undefined, "订单那一格国内单号不跟着产品行改（同运单管理；不然会把超管单独填的号盖掉）");
    assert.equal(patch.weightKg, 2 * 13 + 3 * 7);
    assert.ok(Math.abs((patch.volumeM3 as number) - (2 * 42 * 42 * 41 + 3 * 38 * 37.5 * 38) / 1e6) < 1e-9);
    assert.equal(patch.clientId, undefined); assert.equal(patch.trackingNo, undefined);
  });

  await check("F4 删一款 / 加一款：删掉的那款不带（后端删）、新加的不带行号（后端新建）；产品数量 = Σ 单箱数量 × 件数", () => {
    const base = convertedDraftOf(makeDetail({}, [{ ...P1, productQuantity: 10 }, { ...P2, productQuantity: 4 }]));
    const draft = { ...base, products: [base.products[0], { ...base.products[1], key: "new", orderProductId: undefined, itemName: "支架", packageCount: "2", productQuantity: "5" }] };
    const { patch } = buildAdminOrderPatch("ship1", base, draft);
    assert.deepEqual(patch.products!.map((p) => p.id ?? null), ["op1", null]);
    assert.equal(patch.productQuantity, 10 * 2 + 5 * 2);
  });

  await check("F5 总数按「运单管理」的裁决：尺寸没填齐时以手填为准（不被部分行算出来的数悄悄换掉），填齐了才按产品行算", () => {
    // 第二款没尺寸、没单箱重：运单上手填的总数 33 / 0.199 原样留着 → 没改就不发
    const partial = convertedDraftOf(makeDetail({}, [P1, { ...P2, lengthCm: null, widthCm: null, heightCm: null, weightKg: null }]));
    assert.deepEqual(buildAdminOrderPatch("ship1", partial, { ...partial, remark: "x" }).patch, { orderId: "ship1" });
    const t = convertedTotals(partial);
    assert.equal(t.finalWeight, 33); assert.equal(t.finalVolume, 0.199);
    assert.ok(t.notes.some((n) => n.includes("以手填的")), t.notes.join("；"));
    // 改了手填总重 → 发新的
    assert.equal(buildAdminOrderPatch("ship1", partial, { ...partial, weightKg: "40" }).patch.weightKg, 40);
    // 每款都有单箱重：手填的不生效，按产品行算（同运单管理）
    const full = convertedDraftOf(makeDetail());
    assert.equal(convertedTotals({ ...full, weightKg: "50" }).finalWeight, 33);
  });

  await check("F6 保存前的检查：已经是正式运单，必填项不能空；件数要正整数；乱填的数字拦住（不让 NaN 变成「没填」发出去）", () => {
    const base = convertedDraftOf(makeDetail());
    assert.equal(convertedDraftIssue(base), null);
    assert.match(convertedDraftIssue({ ...base, warehouseId: "", arrivedAt: "" })!, /不能空：仓库、到仓日期/);
    assert.match(convertedDraftIssue({ ...base, transportMode: "" })!, /运输方式/);
    assert.match(convertedDraftIssue({ ...base, products: [{ ...base.products[0], packageCount: "1.5" }, base.products[1]] })!, /第 1 款的件数要填正整数/);
    assert.match(convertedDraftIssue({ ...base, products: [{ ...base.products[0], lengthCm: "abc" }, base.products[1]] })!, /第 1 款的长要填数字/);
    assert.match(convertedDraftIssue({ ...base, weightKg: "3a" })!, /总重量要填数字/);
  });

  await check("F7 「有没有人改过」只比运单那几项（含产品行号），备注不算", () => {
    const a = convertedDraftOf(makeDetail());
    assert.equal(sameConvertedDraft(a, convertedDraftOf(makeDetail({ remark: "别人改了备注" }))), true);
    assert.equal(sameConvertedDraft(a, convertedDraftOf(makeDetail({ weightKg: 40 }))), false);
    assert.equal(sameConvertedDraft(a, convertedDraftOf(makeDetail({}, [P1, P2], ["op1", "op9"]))), false, "产品行被换过（行号变了）也算改过");
  });

  await check("F8 产品数量：一款都没填单箱数量、打开时也没有 → 不发（老单订单上的产品数量不清零）；原来有、清空了 → 发 0；填了 → 发合计", () => {
    const base = convertedDraftOf(makeDetail());
    const draft = { ...base, products: base.products.map((p, i) => (i === 0 ? { ...p, itemName: "改名" } : p)) };
    assert.equal(buildAdminOrderPatch("ship1", base, draft).patch.productQuantity, undefined);
    const withQty = convertedDraftOf(makeDetail({}, [{ ...P1, productQuantity: 10 }, { ...P2, productQuantity: 4 }]));
    const cleared = { ...withQty, products: withQty.products.map((p) => ({ ...p, productQuantity: "" })) };
    assert.equal(buildAdminOrderPatch("ship1", withQty, cleared).patch.productQuantity, 0);
    const filled = { ...base, products: base.products.map((p) => ({ ...p, productQuantity: "3" })) };
    assert.equal(buildAdminOrderPatch("ship1", base, filled).patch.productQuantity, 3 * 2 + 3 * 1);
  });

  await check("F9 带上订单版本（expectedOrderUpdatedAt）：有改动才带；只改备注不碰运单、也不带", () => {
    const base = convertedDraftOf(makeDetail());
    assert.equal(buildAdminOrderPatch("ship1", base, { ...base, warehouseId: "wh_guangzhou_01" }, "V1").patch.expectedOrderUpdatedAt, "V1");
    const only = buildAdminOrderPatch("ship1", base, { ...base, remark: "x" }, "V1");
    assert.equal(only.changed, false);
    assert.equal(only.patch.expectedOrderUpdatedAt, undefined);
  });

  /* ───────────── 二、弹窗 ───────────── */
  await check("B1 打开：写明改的是运单；照片只读（没有删除 / 加照片）；总数框不只读、没有「按产品行算的」", () => {
    mountConverted(makeDetail());
    const all = text(tree);
    assert.match(all, /这票已经转成正式运单。下面是那张运单现在的内容，保存就是改这张运单/);
    assert.match(all, /照片请到「运单管理」那张运单里传 \/ 删/);
    assert.equal(nodes((n) => n.type === "figcaption").length, 0, "已转正式运单的照片不给删");
    assert.equal(nodes((n) => n.props?.className === "an-photo-add").length, 0, "不给加照片");
    assert.equal(field("总重量").props.readOnly, false);
    assert.ok(!all.includes("按产品行算的"));
    assert.equal(field("总重量").props.value, "33");
  });

  await check("B2 改件数保存：先重读运单 → 走超管改单（带行号）→ 刷新卡片和备注；说「运单也改好了」；不走到货通知自己的保存", async () => {
    mountConverted(makeDetail());
    const second = nodes((n) => n.props?.className === "an-prod")[1];
    change("件数", "3", second);
    change("备注", "改成 3 箱");
    await save();
    assert.deepEqual(calls, ["fetch", "update", "refresh"], calls.join(","));
    assert.deepEqual(patches[0].products.map((p: any) => [p.id, p.packageCount]), [["op1", 2], ["op2", 3]]);
    assert.equal(patches[0].orderId, "ship1");
    assert.deepEqual(refreshRemarks, ["改成 3 箱"]);
    assert.deepEqual(refreshExpected, ["内部备注"], "改了备注要带上打开时看到的那份，后端锁里核对");
    assert.equal(patches[0].expectedOrderUpdatedAt, "2026-10-16T09:51:50.000Z", "带上重读到的订单版本");
    assert.equal(patches[0].domesticTrackingNo, undefined);
    assert.match(savedMessage ?? "", /^已保存，那张运单也改好了/);
  });

  await check("B3 打开以后别人在「运单管理」改过（重读的跟打开时的不一样）：不改运单、不刷新，告诉他关掉重开", async () => {
    mountConverted(makeDetail(), makeDetail({ weightKg: 40 }));
    change("备注", "x");
    await save();
    assert.deepEqual(calls, ["fetch"]);
    assert.equal(savedMessage, null);
    assert.match(errorText(), /刚刚被别人改过/);
  });

  await check("B4 只改备注：不碰运单（不调改单），只刷新卡片存备注", async () => {
    mountConverted(makeDetail());
    change("备注", "新备注");
    await save();
    assert.deepEqual(calls, ["fetch", "refresh"]);
    assert.deepEqual(refreshRemarks, ["新备注"]);
    assert.deepEqual(refreshExpected, ["内部备注"]);
  });

  await check("B10 没改备注：刷新卡片时不带备注（后端备注不动 —— 不拿自己手上那份旧备注去盖别人刚改的）", async () => {
    mountConverted(makeDetail());
    change("总重量", "33"); // 等于没改
    const second = nodes((n) => n.props?.className === "an-prod")[1];
    change("件数", "2", second);
    await save();
    assert.deepEqual(calls, ["fetch", "update", "refresh"]);
    assert.deepEqual(refreshRemarks, [null]);
  });

  await check("B11 自己改了备注、同事这期间也改了备注：不存（运单也不改），叫他重开", async () => {
    mountConverted(makeDetail(), makeDetail({ remark: "同事刚写的" }));
    change("备注", "我写的");
    await save();
    assert.deepEqual(calls, ["fetch"]);
    assert.match(errorText(), /备注刚刚被别人改过/);
  });

  await check("B12 同事改了备注、我没碰备注只改件数：照常存运单，刷新卡片不带备注（同事的备注留着）", async () => {
    mountConverted(makeDetail(), makeDetail({ remark: "同事刚写的" }));
    const second = nodes((n) => n.props?.className === "an-prod")[1];
    change("件数", "2", second);
    await save();
    assert.deepEqual(calls, ["fetch", "update", "refresh"]);
    assert.deepEqual(refreshRemarks, [null]);
  });

  await check("B5 整柜的单（blockedReason）：一打开就说去「整柜管理」，保存按钮是灰的", () => {
    mountConverted(makeDetail({}, [P1, P2], ["op1", "op2"], "这是整柜的单，请到「整柜管理」里点「编辑」改"));
    assert.match(errorText(), /整柜管理/);
    assert.equal(button("保存").props.disabled, true);
  });

  await check("B6 运单改好了、刷新卡片失败：照实说「运单已经改好了」，弹窗关掉", async () => {
    mountConverted(makeDetail());
    change("总重量", "34");
    const first = nodes((n) => n.props?.className === "an-prod")[0];
    change("单箱重", "", first); // 第一款没单箱重了 → 总重量以手填为准
    refreshFail = true;
    await save();
    assert.deepEqual(calls, ["fetch", "update", "refresh"]);
    assert.match(savedMessage ?? "", /运单已经改好了，但到货通知这张卡片没刷新成新的（网断了）/);
  });

  await check("B7 必填项清空了：当场拦，一个接口都不调", async () => {
    mountConverted(makeDetail());
    change("到仓日期", "");
    await save();
    assert.deepEqual(calls, []);
    assert.match(errorText(), /不能空：到仓日期/);
  });

  await check("B8 超管改单那条路拒了（比如号撞了）：报它的原话、不刷新卡片", async () => {
    mountConverted(makeDetail());
    change("运单号", "YW0001735");
    updateFail = "trackingNo already exists";
    await save();
    assert.deepEqual(calls, ["fetch", "update"]);
    assert.equal(patches[0].trackingNo, "YW0001735");
    assert.match(errorText(), /trackingNo already exists/);
    assert.equal(savedMessage, null);
  });

  await check("B9 已通知过、换了唛头：后端改回「未通知」后，提示里提醒通知新客户（G01，同普通修改）", async () => {
    mountConverted(makeDetail({ notifiedAt: "2026-10-16T10:00:00.000Z" }), makeDetail({ notifiedAt: "2026-10-16T10:00:00.000Z" }));
    // 唛头是 MarkPicker（不是 input）：直接调它的 onChange
    const picker = nodes((n) => n.props?.placeholder === "输入唛头搜索")[0];
    assert.ok(picker, "找不到唛头下拉");
    picker.props.onChange("ZZB02"); flush();
    await save();
    assert.equal(patches[0].clientId, "ZZB02");
    assert.match(savedMessage ?? "", /已保存，那张运单也改好了。/);
    assert.ok((savedMessage ?? "").length > "已保存，那张运单也改好了。".length, "换唛头要提醒一句");
  });

  /* ───────────── 三、卡片 ───────────── */
  await check("B13 封禁的唛头（已转正式那条，dsh 第 9 轮）：保存走超管改单、唛头去首尾空格再比再发 —— 页面也去了再认：换成「 ZZB02 」（封禁）提示账号已封禁、不说没有这个唛头；原来就是封禁的 ZZA01、只多打个空格不提示", () => {
    const warns = () => nodes((n) => n.props?.className === "an-warn").map(text);
    const pick = (v: string) => { nodes((n) => n.props?.placeholder === "输入唛头搜索" && typeof n.props?.onChange === "function")[0].props.onChange(v); flush(); };
    mountConverted(makeDetail());
    props = { ...props, bannedClients: new Set(["ZZB02"]) }; flush();
    pick(" ZZB02 ");
    assert.deepEqual(warns(), ["账号已封禁"]);
    mountConverted(makeDetail());
    props = { ...props, clients: [{ id: "ZZB02" }], bannedClients: new Set(["ZZA01"]) }; flush();
    pick("ZZA01 ");
    assert.deepEqual(warns(), [], "原来就是它（去了空格一样），已转正式：不提示");
    // 已标「已通知」的：只多打个空格不算换了唛头（不出「保存后会改回未通知」）；真换成别的唛头才出（dsh 第 10 轮：G01 也按保存时的认法）
    mountConverted(makeDetail({ notifiedAt: "2026-10-16T10:00:00.000Z" }));
    props = { ...props, clients: [{ id: "ZZA01" }, { id: "ZZB02" }], bannedClients: new Set() }; flush();
    pick("ZZA01 ");
    assert.deepEqual(warns(), [], "多打个空格不算换了唛头");
    pick(" ZZB02 ");
    assert.ok(warns().some((w) => /换了唛头，保存后会改回「未通知」/.test(w)), warns().join(" / "));
  });

  await check("C1 卡片：没转的有「修改」；已转正式的只有 canEditConverted 才有（员工那份后端给 false）", () => {
    const card = (n: any) => mod.exports.NoticeCard({ n, busy: false, busyIds: new Set(), onCopyText() {}, onCopyImage() {}, onSaveImage() {}, onPreview() {}, onToggleNotified() {}, onEdit() {}, onConvert() {}, onDelete() {} });
    const hasEdit = (n: any) => { hooks = []; index = 0; const t = card(n); return nodes((x) => x.type === "button" && text(x) === "修改", t).length > 0; };
    const base = makeDetail().item;
    assert.equal(hasEdit({ ...base, canEditConverted: true }), true);
    assert.equal(hasEdit({ ...base, canEditConverted: false }), false);
    assert.equal(hasEdit({ ...base, canEditConverted: undefined }), false, "老后端不回这个字段 = 不给改");
    assert.equal(hasEdit({ ...base, convertedTo: null, shipmentId: null, canEditConverted: false }), true);
    // 按钮真接着 onEdit（不光是父组件传了，Codex 第 3 轮）
    let clicked = 0;
    hooks = []; index = 0;
    const t = mod.exports.NoticeCard({ n: { ...base, canEditConverted: true }, busy: false, busyIds: new Set(), onCopyText() {}, onCopyImage() {}, onSaveImage() {}, onPreview() {}, onToggleNotified() {}, onEdit() { clicked += 1; }, onConvert() {}, onDelete() {} });
    nodes((x) => x.type === "button" && text(x) === "修改", t)[0].props.onClick();
    assert.equal(clicked, 1, "卡片上的「修改」按钮没接到 onEdit");
  });

  await check("C2 列表点「修改」：已转正式的先读运单现在的样子再开弹窗（onEditConverted，只认最后一次），没转的照旧", () => {
    const src = fs.readFileSync(file, "utf8");
    assert.match(src, /onEdit=\{\(\) => \(n\.convertedTo === "formal" \? void onEditConverted\(n\) : openEditor\(\{ mode: "edit", item: n \}\)\)\}/);
    assert.match(src, /const ticket = openGate\.current\.begin\(\);[\s\S]{0,200}detail = await fetchConvertedNoticeDetail\(n\.id\);[\s\S]{0,200}if \(!openGate\.current\.isCurrent\(ticket\)\) return;[^\n]*\n\s*throw e;[\s\S]{0,80}if \(!openGate\.current\.isCurrent\(ticket\)\) return;[^\n]*\n\s*openEditor\(\{ mode: "converted", item: detail\.item, detail \}\);/, "连点两条：只认最后一次（成功、失败都看门闩）");
    assert.match(src, /const openEditor = [^\n]*\n\s*openGate\.current\.cancel\(\);/, "开别的弹窗要作废还在路上的那次");
    assert.match(src, /const closeEditor = \(seq: number\) => \{ openGate\.current\.cancel\(\);/, "关弹窗也作废");
  });

  /* ───────────── 四、整页：连点两条「修改」 ───────────── */
  const A = { ...makeDetail().item, id: "nA", clientId: "ZZA01" };
  const B = { ...makeDetail().item, id: "nB", clientId: "ZZB02" };
  const detailOf = (item: any) => ({ ...makeDetail(), item });
  const clickEdit = (id: string) => cards().find((c) => c.props.n.id === id)!.props.onEdit();

  await check("G1 先点 A 再点 B，B 先回来：开的是 B；A 晚回来也不把弹窗换成 A", async () => {
    await mountView([A, B]);
    assert.equal(cards().length, 2, "列表没出来");
    clickEdit("nA"); clickEdit("nB"); await settle();
    pendingDetails.get("nB")!.resolve(detailOf(B)); await settle();
    assert.equal(openedEditor()?.item.id, "nB");
    pendingDetails.get("nA")!.resolve(detailOf(A)); await settle();
    assert.equal(openedEditor()?.item.id, "nB", "A 晚回来把弹窗换成了 A");
  });

  await check("G2 先点 A 再点 B：B 开着，A 晚回来是失败 —— 不在页面上报 A 的错", async () => {
    await mountView([A, B]);
    clickEdit("nA"); clickEdit("nB"); await settle();
    pendingDetails.get("nB")!.resolve(detailOf(B)); await settle();
    pendingDetails.get("nA")!.reject(new Error("A 那条的错")); await settle();
    assert.equal(openedEditor()?.item.id, "nB");
    assert.deepEqual(errorToasts(), []);
  });

  await check("G3 点了 A（还在读）就去点「登记到货」：A 回来不把新登记的弹窗换掉；只点 A 时照常打开 A、失败照常报", async () => {
    await mountView([A, B]);
    clickEdit("nA"); await settle();
    nodes((n) => n.type === "button" && text(n) === "＋ 登记到货", viewTree)[0].props.onClick(); await settle();
    pendingDetails.get("nA")!.resolve(detailOf(A)); await settle();
    assert.equal(openedEditor()?.mode, "new");
    await mountView([A, B]);
    clickEdit("nA"); await settle();
    pendingDetails.get("nA")!.resolve(detailOf(A)); await settle();
    assert.equal(openedEditor()?.item.id, "nA");
    await mountView([A, B]);
    clickEdit("nB"); await settle();
    pendingDetails.get("nB")!.reject(new Error("网断了")); await settle();
    assert.deepEqual(errorToasts(), ["网断了"]);
  });

  await check("G4 封禁的唛头（2026-10-17）：整页拿到客户名单后，弹窗的下拉里没有封禁的（只剩唛头、不带名字），封禁名单单独交给弹窗用来提示；收到「账号」推送重拉，重拉失败手上那份不动", async () => {
    staffClientsMock = [{ id: "ZZOK1", name: "甲", status: "active" }, { id: "ZZBAN1", name: "乙", status: "inactive" }, { id: "ZZOLD", name: "老接口没带状态" }];
    try {
      await mountView([A, B]);
      nodes((n) => n.type === "button" && text(n) === "＋ 登记到货", viewTree)[0].props.onClick(); await settle();
      const ed = nodes((n) => n.type === mod.exports.NoticeEditor, viewTree)[0];
      assert.ok(ed, "登记弹窗没开");
      assert.deepEqual(ed.props.clients, [{ id: "ZZOK1" }, { id: "ZZOLD" }], "下拉只给没封的（没带状态的当没封）");
      assert.deepEqual([...ed.props.bannedClients], ["ZZBAN1"]);
      // 弹窗开着时超管解封了 ZZBAN1、封了 ZZOK1：收到「账号」推送就重拉名单（Codex 审查：原来只在打开页面时拉一次）
      const onAccounts = liveRefresh.get("accounts");
      assert.ok(onAccounts, "页面没订「账号」推送");
      staffClientsMock = [{ id: "ZZOK1", name: "甲", status: "inactive" }, { id: "ZZBAN1", name: "乙", status: "active" }];
      await onAccounts!(); await settle();
      const ed2 = nodes((n) => n.type === mod.exports.NoticeEditor, viewTree)[0];
      assert.deepEqual(ed2.props.clients, [{ id: "ZZBAN1" }]);
      assert.deepEqual([...ed2.props.bannedClients], ["ZZOK1"]);
      // 重拉失败：手上那份不动、也不说「名单没拿到」
      const keep = ed2.props.clients;
      staffClientsMock = null as any;
      await onAccounts!(); await settle();
      const ed3 = nodes((n) => n.type === mod.exports.NoticeEditor, viewTree)[0];
      assert.deepEqual(ed3.props.clients, keep);
      assert.equal(ed3.props.clientsFailed, false);
    } finally { staffClientsMock = []; }
  });

  await check("G4b 客户名单两次请求倒着回来（打开页面那次晚于「账号」推送那次）：显示的还是后发那次的，封了的唛头不会被旧名单放回来", async () => {
    clientsDeferred = [];
    try {
      await mountView([A, B]); // 打开页面那次：挂起
      nodes((n) => n.type === "button" && text(n) === "＋ 登记到货", viewTree)[0].props.onClick();
      await settle();
      assert.equal(clientsDeferred.length, 1);
      const onAccounts = liveRefresh.get("accounts")!;
      const pushed = onAccounts(); await settle(); // 推送那次：也挂起
      assert.equal(clientsDeferred.length, 2);
      clientsDeferred[1]([{ id: "ZZOK1", name: "甲", status: "active" }, { id: "ZZBAN1", name: "乙", status: "inactive" }]); // 后发的先回
      await pushed; await settle();
      clientsDeferred[0]([{ id: "ZZOK1", name: "甲", status: "active" }, { id: "ZZBAN1", name: "乙", status: "active" }]); // 打开页面那次（封禁前的旧名单）晚回来
      await settle();
      const ed = nodes((n) => n.type === mod.exports.NoticeEditor, viewTree)[0];
      assert.ok(ed, "登记弹窗没开");
      assert.deepEqual(ed.props.clients, [{ id: "ZZOK1" }], "旧名单把封了的唛头放回来了");
      assert.deepEqual([...ed.props.bannedClients], ["ZZBAN1"]);
    } finally { clientsDeferred = null; }
  });

  /* ───────────── 五、页面真正发请求的那两个函数（参数名写错的话后端核对等于没有） ───────────── */
  await check("S1 读运单带 v=2（后端只认新页面）；存备注带 remark + expectedRemark，没改备注只带 id", async () => {
    const api = realRequire("../../services/arrival-notice-api");
    const sent: Array<{ url: string; body: any }> = [];
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: string, init: any) => {
      sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ code: "OK", message: "success", data: { item: {} } }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    try {
      await api.fetchConvertedNoticeDetail("n1");
      await api.refreshConvertedNotice("n1", { value: " 新备注 ", expected: " 旧备注 " });
      await api.refreshConvertedNotice("n1");
    } finally { (globalThis as any).fetch = origFetch; }
    assert.match(sent[0].url, /\/staff\/arrival-notices\/converted-detail\?id=n1&v=2$/);
    assert.deepEqual(sent[1].body, { id: "n1", remark: "新备注", expectedRemark: "旧备注" });
    assert.deepEqual(sent[2].body, { id: "n1" });
  });

  if (failures > 0) { console.log(`\n${failures} 项没过`); process.exit(1); }
  console.log("\n超管改已转正式运单（不连库）全部通过");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
