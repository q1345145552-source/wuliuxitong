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
    orderId: "o1", shipmentId: "ship1", productIds, blockedReason,
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
let refreshRemarks: string[] = [];
let refreshFail = false;
let refreshNotifiedAt: string | null = null;
let updateFail: string | null = null;
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
      fetchConvertedNoticeDetail: async () => { calls.push("fetch"); return freshDetail; },
      refreshConvertedNotice: async (_id: string, remark: string) => {
        calls.push("refresh"); refreshRemarks.push(remark);
        if (refreshFail) throw new Error("网断了");
        return { item: { ...freshDetail.item, remark, notifiedAt: refreshNotifiedAt } };
      },
      saveArrivalNotice: async () => { calls.push("save-notice"); throw new Error("已转正式运单不该走到货通知自己的保存"); },
    };
  }
  if (id === "../../services/business-api") {
    return { ...real, updateAdminOrder: async (patch: any) => { calls.push("update"); patches.push(patch); if (updateFail) throw new Error(updateFail); return { orderId: "o1" }; } };
  }
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
  hooks = []; effects = []; calls = []; patches = []; refreshRemarks = []; refreshFail = false; refreshNotifiedAt = null; updateFail = null; savedMessage = null;
  freshDetail = fresh;
  props = {
    editor: { mode: "converted", item: detail.item, detail, seq: 1 },
    clients: [{ id: "ZZA01" }, { id: "ZZB02" }], clientsFailed: false,
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

  await check("F3 改了一款的件数：产品整份发、带原来的行号；件数合计、品名、国内单号（第一款真有的）、总数（按产品行算）一起发", () => {
    const base = convertedDraftOf(makeDetail());
    const draft = { ...base, products: base.products.map((p, i) => (i === 1 ? { ...p, packageCount: "3" } : p)) };
    const { patch } = buildAdminOrderPatch("ship1", base, draft);
    assert.deepEqual(patch.products!.map((p) => p.id), ["op1", "op2"]);
    assert.deepEqual(patch.products!.map((p) => p.packageCount), [2, 3]);
    assert.equal(patch.products![1].domesticTrackingNo, "货拉拉", "空着的国内单号写「货拉拉」（同创建订单 / 运单管理）");
    assert.equal(patch.packageCount, 5);
    assert.equal(patch.itemName, "冰敷袋");
    assert.equal(patch.domesticTrackingNo, "S665");
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
  await check("C1 卡片：没转的有「修改」；已转正式的只有 canEditConverted 才有（员工那份后端给 false）", () => {
    const card = (n: any) => mod.exports.NoticeCard({ n, busy: false, busyIds: new Set(), onCopyText() {}, onCopyImage() {}, onSaveImage() {}, onPreview() {}, onToggleNotified() {}, onEdit() {}, onConvert() {}, onDelete() {} });
    const hasEdit = (n: any) => { hooks = []; index = 0; const t = card(n); return nodes((x) => x.type === "button" && text(x) === "修改", t).length > 0; };
    const base = makeDetail().item;
    assert.equal(hasEdit({ ...base, canEditConverted: true }), true);
    assert.equal(hasEdit({ ...base, canEditConverted: false }), false);
    assert.equal(hasEdit({ ...base, canEditConverted: undefined }), false, "老后端不回这个字段 = 不给改");
    assert.equal(hasEdit({ ...base, convertedTo: null, shipmentId: null, canEditConverted: false }), true);
  });

  await check("C2 列表点「修改」：已转正式的先读运单现在的样子再开弹窗（onEditConverted），没转的照旧", () => {
    const src = fs.readFileSync(file, "utf8");
    assert.match(src, /onEdit=\{\(\) => \(n\.convertedTo === "formal" \? void onEditConverted\(n\) : openEditor\(\{ mode: "edit", item: n \}\)\)\}/);
    assert.match(src, /const detail = await fetchConvertedNoticeDetail\(n\.id\);\s*openEditor\(\{ mode: "converted", item: detail\.item, detail \}\);/);
  });

  if (failures > 0) { console.log(`\n${failures} 项没过`); process.exit(1); }
  console.log("\n超管改已转正式运单（不连库）全部通过");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
