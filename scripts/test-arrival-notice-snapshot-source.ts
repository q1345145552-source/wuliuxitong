/**
 * 到货通知转正式运单时存原样（2026-10-19 老板选 B）—— 不连库那一半。连库的在 test-arrival-notice-snapshot-db.ts，迁移在 test-migration-arrival-notice-snapshots-db.ts。
 * 计划和老板认可的细节：.audit/2026-10-19/notice-snapshot/plan.md。
 *
 *   S1～S5 比对函数（snapshot-diff.ts）直接调：一样的不标、改了的标出「原来 → 现在」、多一款 / 少一款单独一行、
 *          仓库 / 运输方式说中文、空的跟没填当一回事、卡片上那一行产品写法只有一份
 *   R1～R7 弹窗（SnapshotModal）真跑起来（假 React，接口换成桩）：读取中、上线前转的、一份 / 两份（最近一次在前）、
 *          改过的那行标「改过」、没改的写「同左」、谁转的只在后端给了才显示、坏的那份、读失败、关掉以后晚回来的不管
 *   C1～C2 卡片（NoticeCard）：存过就给按钮（几份写几份，运单被删回到「没转」的也给）；已转正式没存过的写「上线前转的，没存原样」；
 *          待入库 / 没转的什么都不写
 *   V1     页面接线：弹窗 key 带前缀（同层还有按数字给 key 的 Toast，教训 39）、拿列表里这张卡片现在的样子比、关的是自己那一次
 *   B1～B3 后端：存原样跟转运单在同一个事务里、只在转正式时存；读原样谁转的只给超管；存的字段跟页面的类型一一对上
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import { productLine, snapshotChangeCount, snapshotMetaRows, snapshotProductRows } from "../apps/web/src/modules/arrival-notice/snapshot-diff";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; console.log(`❌ ${name}\n   ${(e instanceof Error ? e.stack ?? e.message : String(e)).split("\n").slice(0, 6).join("\n   ")}`); }
}

/* ───────────── 夹具 ───────────── */
const P = (o: Record<string, unknown> = {}): any => ({ itemName: null, packageCount: null, lengthCm: null, widthCm: null, heightCm: null, productQuantity: null, weightKg: null, cargoType: "normal", domesticTrackingNo: null, ...o });
const LAMP = P({ itemName: "灯具", packageCount: 10, lengthCm: 60, widthCm: 40, heightCm: 30, productQuantity: 10, weightKg: 5, domesticTrackingNo: "SF123" });
const SHOE = P({ itemName: "鞋", packageCount: 5, cargoType: "sensitive", domesticTrackingNo: "YT9" });
const SNAP: any = {
  v: 1, clientId: "ZZA01", trackingNo: "YW0001", warehouseId: "wh_yiwu_01", transportMode: "sea", arrivedAt: "2026-10-19",
  weightKg: 75, volumeM3: 0.72, remark: "外箱破损", products: [LAMP, SHOE],
};
const card = (o: Record<string, unknown> = {}): any => ({
  id: "n1", clientId: "ZZA01", trackingNo: "YW0001", warehouseId: "wh_yiwu_01", transportMode: "sea", arrivedAt: "2026-10-19",
  weightKg: 75, volumeM3: 0.72, remark: "外箱破损", products: [LAMP, SHOE], itemName: "灯具、鞋", packageCount: 15, cargoType: null, domesticTrackingNo: "SF123",
  notifiedAt: null, notifiedByName: null, convertedTo: "formal", shipmentId: "s1", shipmentStatus: "inWarehouseCN", shipmentGone: false,
  convertedAt: "2026-10-19T02:00:00.000Z", createdByName: null, createdAt: "2026-10-19T01:00:00.000Z", updatedAt: "2026-10-19T02:00:00.000Z",
  images: [], prealertMatches: [], snapshotCount: 1, ...o,
});

/* ───────────── 弹窗 / 卡片：假 React 跑起来（同 test-arrival-notice-converted-edit.ts） ───────────── */
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
  useCallback(fn: any) { index++; return fn; },
  useLayoutEffect() { index++; },
};
(globalThis as any).window = { setTimeout, clearTimeout, confirm: () => true, localStorage: { getItem: () => null, setItem() {} } };
const runtime = { jsx: (type: any, p: any, key: any) => ({ type, props: p, key }), jsxs: (type: any, p: any, key: any) => ({ type, props: p, key }), Fragment: "fragment" };

/** 读原样接口的桩：每次调用挂起，测试自己决定回什么 */
let pending: Array<{ id: string; resolve: (v: any) => void; reject: (e: unknown) => void }> = [];
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
      return { ...real, fetchArrivalNoticeSnapshots: (nid: string) => new Promise((resolve, reject) => pending.push({ id: nid, resolve, reject })) };
    }
    return real;
  }, mod);
  return mod.exports;
}
const Modal = load("apps/web/src/modules/arrival-notice/SnapshotModal.tsx");
const View = load("apps/web/src/modules/arrival-notice/ArrivalNoticesView.tsx", "\nexport { NoticeCard };");

/** 把不带 hook 的小组件（DiffTable、DetailModal 桩）往下展开，得到一棵只有原生元素的树 */
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

let props: any, tree: any;
function flush() {
  for (let n = 0; n < 30; n++) {
    index = 0; dirty = false; tree = expand(Modal.default(props));
    const queue = effects; effects = [];
    for (const fn of queue) { const c = fn(); if (typeof c === "function") cleanups.push(c as () => void); }
    if (!dirty) return;
  }
  throw new Error("无限重画");
}
function mount(notice: any, current: any = notice) {
  hooks = []; effects = []; cleanups = []; pending = [];
  props = { notice, current, onClose() {} };
  flush();
}
function unmount() { cleanups.forEach((c) => c()); cleanups = []; }
async function answer(v: any, fail = false) {
  const p = pending.shift();
  assert.ok(p, "弹窗没去读原样");
  if (fail) p.reject(v); else p.resolve(v);
  await new Promise<void>((r) => setImmediate(r));
  flush();
}
const sections = () => nodes((n) => n.type === "section", tree);
const rowsOf = (root: any) => nodes((n) => n.type === "tr" && n.props?.children?.[0]?.type === "th" && n.props.children[0].props?.scope === "row", root)
  .map((tr) => ({ label: text(tr.props.children[0]).replace("改过", ""), flagged: text(tr.props.children[0]).endsWith("改过"), cls: tr.props.className ?? "", was: text(tr.props.children[1]), now: text(tr.props.children[2]) }));

async function main(): Promise<void> {
  console.log("到货通知存原样（不连库）");

  /* ───────────── 比对函数 ───────────── */
  await check("S1 跟现在一样：整票 8 项 + 两款产品，一处都不标；数 = 0", () => {
    const rows = [...snapshotMetaRows(SNAP, card()), ...snapshotProductRows(SNAP, card())];
    assert.deepEqual(rows.map((r) => r.label), ["唛头", "运单号", "仓库", "运输方式", "到仓日期", "总重量", "总体积", "备注", "第 1 款", "第 2 款"]);
    assert.deepEqual(rows.filter((r) => r.changed), []);
    assert.equal(snapshotChangeCount(SNAP, card()), 0);
  });

  await check("S2 运单管理改了第 1 款件数、总重、运单号：只标这三处，「原来 → 现在」两边都写清", () => {
    const now = card({ trackingNo: "YW0002", weightKg: 80, products: [{ ...LAMP, packageCount: 12 }, SHOE] });
    const changed = [...snapshotMetaRows(SNAP, now), ...snapshotProductRows(SNAP, now)].filter((r) => r.changed);
    assert.deepEqual(changed.map((r) => r.label), ["运单号", "总重量", "第 1 款"]);
    assert.deepEqual([changed[0].was, changed[0].now], ["YW0001", "YW0002"]);
    assert.deepEqual([changed[1].was, changed[1].now], ["75 kg", "80 kg"]);
    assert.ok(changed[2].was.includes("× 10 件") && changed[2].now.includes("× 12 件"), `${changed[2].was} / ${changed[2].now}`);
    assert.equal(snapshotChangeCount(SNAP, now), 3);
  });

  await check("S3 运单那边删了一款 / 加了一款：多出来的那一行一边是空的", () => {
    const fewer = snapshotProductRows(SNAP, card({ products: [LAMP] }));
    assert.deepEqual(fewer.map((r) => [r.label, r.changed, r.now]), [["第 1 款", false, productLine(LAMP)], ["第 2 款", true, ""]]);
    const more = snapshotProductRows(SNAP, card({ products: [LAMP, SHOE, P({ itemName: "支架", packageCount: 2 })] }));
    assert.deepEqual(more.map((r) => [r.label, r.changed, r.was]), [["第 1 款", false, productLine(LAMP)], ["第 2 款", false, productLine(SHOE)], ["第 3 款", true, ""]]);
  });

  await check("S4 仓库 / 运输方式说中文；空的、null、只有空格的备注当一回事；产品一款没登记的两边都是空", () => {
    const meta = snapshotMetaRows({ ...SNAP, warehouseId: "wh_guangzhou_01", transportMode: "land", remark: null }, card({ warehouseId: "wh_yiwu_01", transportMode: "sea", remark: "  " }));
    const by = Object.fromEntries(meta.map((r) => [r.label, r]));
    assert.deepEqual([by["仓库"].was, by["仓库"].now], ["广州仓", "义乌仓"]);
    assert.deepEqual([by["运输方式"].was, by["运输方式"].now], ["陆运", "海运"]);
    assert.equal(by["备注"].changed, false, "null 跟只有空格的备注都是「没填」");
    assert.deepEqual(snapshotProductRows({ ...SNAP, products: [] }, card({ products: [] })), []);
  });

  await check("S5 卡片上那一行产品写法只有一份（页面从 snapshot-diff 引，不再自己写一个），比对用的就是它", () => {
    const view = read("apps/web/src/modules/arrival-notice/ArrivalNoticesView.tsx");
    assert.ok(!/function productLine\(/.test(view), "ArrivalNoticesView 里又自己写了一个 productLine，两边会写得不一样");
    assert.match(view, /import \{[^}]*\bproductLine\b[^}]*\} from "\.\/snapshot-diff"/);
    assert.equal(productLine(LAMP), "灯具 × 10 件 · 国内单号 SF123 · 60×40×30cm · 单箱 5kg · 每箱 10 个");
    assert.equal(productLine(SHOE), "鞋 × 5 件 · 敏感货 · 国内单号 YT9");
  });

  /* ───────────── 弹窗 ───────────── */
  await check("R1 一打开就去读这一条的原样，没回来时写「读取中…」", () => {
    mount(card());
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, "n1");
    assert.ok(text(tree).includes("读取中…"), text(tree));
    assert.equal(tree.type, "modal");
    assert.equal(tree.props.title, "转运单时的原样");
  });

  await check("R2 一份都没有（上线前转的）：照实说「这条没有存原样（上线前转的）」", async () => {
    mount(card({ snapshotCount: 0 }));
    await answer({ items: [] });
    assert.ok(text(tree).includes("这条没有存原样（上线前转的）"), text(tree));
    assert.ok(!text(tree).includes("读取中"), "回来了还写读取中");
    assert.equal(sections().length, 0);
  });

  await check("R3 一份、运单改过件数：标题写「有 1 处跟现在不一样」；改过那一行标「改过」、写现在的；没改的写「同左」；员工看不到谁转的", async () => {
    const now = card({ products: [{ ...LAMP, packageCount: 12 }, SHOE] });
    mount(card(), now);
    await answer({ items: [{ id: "a1", convertedAt: "2026-10-19T02:05:00.000Z", convertedByName: null, data: SNAP }] });
    const [s] = sections();
    assert.ok(s, "没画出那一份");
    const head = text(nodes((n) => n.type === "h4", s));
    assert.ok(head.startsWith("2026/10/19 10:05"), `时间按北京时间：${head}`);
    assert.ok(!head.includes("最近一次") && !head.includes("转的"), `只有一份不写「最近一次」、员工不写谁转的：${head}`);
    assert.ok(head.includes("有 1 处跟现在不一样"), head);
    const rows = rowsOf(s);
    const lamp = rows.find((r) => r.label === "第 1 款")!;
    assert.ok(lamp.flagged && lamp.cls === "is-changed", JSON.stringify(lamp));
    assert.ok(lamp.was.includes("× 10 件") && lamp.now.includes("× 12 件"), JSON.stringify(lamp));
    const shoe = rows.find((r) => r.label === "第 2 款")!;
    assert.deepEqual([shoe.flagged, shoe.cls, shoe.now], [false, "", "同左"]);
    assert.equal(rows.find((r) => r.label === "唛头")!.now, "同左");
    assert.equal(rows.filter((r) => r.flagged).length, 1);
  });

  await check("R4 两份（运单被删、重转过）：照后端给的顺序，第一份写「最近一次转运单」、第二份「更早一次」；超管拿到名字才写谁转的", async () => {
    mount(card({ snapshotCount: 2 }));
    await answer({ items: [
      { id: "a2", convertedAt: "2026-10-19T03:00:00.000Z", convertedByName: "员工小李", data: { ...SNAP, remark: "重转前改过" } },
      { id: "a1", convertedAt: "2026-10-19T02:00:00.000Z", convertedByName: null, data: SNAP },
    ] });
    const heads = sections().map((s) => text(nodes((n) => n.type === "h4", s)));
    assert.equal(heads.length, 2);
    assert.ok(heads[0].startsWith("最近一次转运单：2026/10/19 11:00 · 员工小李 转的"), heads[0]);
    assert.ok(heads[0].includes("有 1 处跟现在不一样"), heads[0]);
    assert.ok(heads[1].startsWith("更早一次转运单：2026/10/19 10:00") && !heads[1].includes("转的"), heads[1]);
    assert.ok(heads[1].includes("跟现在一样"), heads[1]);
    assert.deepEqual(sections().map((s) => s.key), ["a2", "a1"]);
  });

  await check("R5 存的那份坏了（后端给 null）：这一份写「读不出来」，不报错，另一份照常比", async () => {
    mount(card());
    await answer({ items: [{ id: "bad", convertedAt: "2026-10-19T03:00:00.000Z", convertedByName: null, data: null }, { id: "a1", convertedAt: "2026-10-19T02:00:00.000Z", convertedByName: null, data: SNAP }] });
    const [bad, good] = sections();
    assert.ok(text(bad).includes("这一份读不出来"), text(bad));
    assert.equal(rowsOf(bad).length, 0);
    assert.ok(text(good).includes("跟现在一样"), text(good));
  });

  await check("R6 读失败：写「读原样失败：原因」，不写读取中、也不写「没有存原样」", async () => {
    mount(card());
    await answer(new Error("网断了"), true);
    const t = text(tree);
    assert.ok(t.includes("读原样失败：网断了"), t);
    assert.ok(!t.includes("读取中") && !t.includes("没有存原样"), t);
  });

  await check("R7 关掉以后才回来的：不再往已经关掉的弹窗里写", async () => {
    mount(card());
    unmount();
    const p = pending.shift()!;
    p.resolve({ items: [{ id: "a1", convertedAt: "2026-10-19T02:00:00.000Z", convertedByName: null, data: SNAP }] });
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(dirty, false, "关掉了还在改状态");
    assert.equal(hooks[0], null, "关掉了还写进了原样");
  });

  /* ───────────── 卡片 ───────────── */
  const renderCard = (n: any, onView = () => {}) => {
    hooks = []; effects = []; index = 0;
    return View.NoticeCard({ n, busy: false, busyIds: new Set(), onCopyText() {}, onCopyImage() {}, onSaveImage() {}, onPreview() {}, onToggleNotified() {}, onEdit() {}, onConvert() {}, onDelete() {}, onViewSnapshots: onView });
  };
  const footer = (t: any) => nodes((n) => n.type === "footer", t)[0];
  const snapButton = (t: any) => nodes((n) => n.type === "button" && text(n).startsWith("看转运单时的原样"), footer(t))[0];

  await check("C1 存过原样就给按钮：一份不写份数、两份写「（2 份）」；运单被删回到「没转」的也给；点了叫 onViewSnapshots", () => {
    let clicked = 0;
    const one = renderCard(card({ snapshotCount: 1 }), () => { clicked++; });
    assert.equal(text(snapButton(one)), "看转运单时的原样");
    snapButton(one).props.onClick();
    assert.equal(clicked, 1);
    assert.equal(text(snapButton(renderCard(card({ snapshotCount: 2 })))), "看转运单时的原样（2 份）");
    const gone = renderCard(card({ snapshotCount: 1, convertedTo: null, shipmentId: null, shipmentGone: true }));
    assert.ok(snapButton(gone), "运单被删、回到「没转」的，以前那份照样给看");
    assert.ok(!text(footer(gone)).includes("上线前转的"));
  });

  await check("C2 已转正式、一份没存（上线前转的）：写「上线前转的，没存原样」不给按钮；待入库 / 没转的、老后端不回份数的没转单：什么都不写", () => {
    const old = renderCard(card({ snapshotCount: 0 }));
    assert.equal(snapButton(old), undefined);
    assert.ok(text(footer(old)).includes("上线前转的，没存原样"), text(footer(old)));
    const oldBackend = renderCard(card({ snapshotCount: undefined }));
    assert.ok(text(footer(oldBackend)).includes("上线前转的，没存原样"), "老后端不回 snapshotCount 当 0");
    for (const n of [card({ snapshotCount: 0, convertedTo: "inbound" }), card({ snapshotCount: 0, convertedTo: null, shipmentId: null }), card({ snapshotCount: undefined, convertedTo: null, shipmentId: null })]) {
      const t = renderCard(n);
      assert.equal(snapButton(t), undefined, n.convertedTo);
      assert.ok(!text(footer(t)).includes("原样"), `${n.convertedTo}：${text(footer(t))}`);
    }
  });

  /* ───────────── 页面接线 ───────────── */
  await check("V1 页面：弹窗 key 带「snap-」前缀（同层有 Toast key={toast.seq}，教训 39）；拿列表里这张卡片现在的样子比；关的只是自己那一次", () => {
    const view = read("apps/web/src/modules/arrival-notice/ArrivalNoticesView.tsx");
    const block = view.slice(view.indexOf("<SnapshotModal"), view.indexOf("/>", view.indexOf("<SnapshotModal")));
    assert.match(block, /key=\{`snap-\$\{snapView\.seq\}`\}/);
    assert.match(block, /current=\{data\?\.items\.find\(\(x\) => x\.id === snapView\.notice\.id\) \?\? snapView\.notice\}/);
    assert.match(block, /onClose=\{\(\) => \{ const seq = snapView\.seq; setSnapView\(\(v\) => \(v && v\.seq === seq \? null : v\)\); \}\}/);
    assert.match(view, /onViewSnapshots=\{\(\) => \{ snapSeqRef\.current \+= 1; setSnapView\(\{ seq: snapSeqRef\.current, notice: n \}\); \}\}/);
    // 同一层按数字给 key 的兄弟元素：除了 Toast 之外都要带前缀
    const code = view.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    const bare = [...code.matchAll(/\bkey=\{([a-zA-Z]+)\.seq\}/g)].map((m) => m[1]);
    assert.deepEqual(bare, ["toast"], `又有裸数字 key：${bare.join("、")}`);
  });

  /* ───────────── 后端 ───────────── */
  const api = read("apps/api/src/modules/arrival-notices/routes.ts");
  await check("B1 存原样在转运单的同一个事务里、写在标记「已转」之后、只在转正式时存；存的是锁里读的 f（转之前那份）", () => {
    const start = api.indexOf('app.post("/staff/arrival-notices/convert"');
    const body = api.slice(start, api.indexOf("app.get(\"/staff/arrival-notices/snapshots\"", start));
    const tx = body.indexOf("prisma.$transaction(");
    const mark = body.indexOf("data: { convertedTo: to, shipmentId, convertedAt: now }");
    const snap = body.indexOf("tx.arrivalNoticeSnapshot.create(");
    const end = body.indexOf("}, { timeout: 30000, maxWait: 10000 });", snap);
    assert.ok(tx > 0 && mark > tx && snap > mark && end > snap, `位置不对：事务 ${tx} / 标记 ${mark} / 存原样 ${snap} / 事务收尾 ${end}`);
    assert.match(body.slice(mark, snap), /if \(to === "formal"\) \{\s*await $/);
    assert.match(body.slice(snap, end), /data: JSON\.stringify\(snapshotDataOf\(f\)\)/);
    assert.equal((api.match(/arrivalNoticeSnapshot\.create\(/g) ?? []).length, 1, "只有转正式这一处存原样");
    assert.ok(!/arrivalNoticeSnapshot\.(update|upsert|updateMany|delete|deleteMany)\(/.test(api), "原样不许改、不许删（删到货通知靠外键跟着删）");
  });

  await check("B2 读原样：只给员工 / 超管、按公司查、新的在前；谁转的只给超管（canSeeOperatorIdentity）", () => {
    const start = api.indexOf('app.get("/staff/arrival-notices/snapshots"');
    const body = api.slice(start, api.indexOf("app.post(", start));
    assert.match(body, /requireRole\(req, res, \["staff", "admin"\]\)/);
    assert.match(body, /where: \{ id, companyId: auth\.companyId \}/);
    assert.match(body, /where: \{ noticeId: id, companyId: auth\.companyId \}/);
    assert.match(body, /orderBy: \[\{ createdAt: "desc" \}, \{ id: "desc" \}\]/);
    assert.match(body, /const showWho = canSeeOperatorIdentity\(auth\.role\);/);
    assert.match(body, /convertedByName: showWho \? r\.convertedByName : null/);
  });

  await check("B3 后端存的字段 = 页面认的字段（整票 + 每款产品），一项不多一项不少", () => {
    const web = read("apps/web/src/services/arrival-notice-api.ts");
    const keysOf = (src: string, name: string) => {
      const s = src.indexOf(`export interface ${name} {`);
      assert.ok(s >= 0, `找不到 ${name}`);
      let depth = 0, i = src.indexOf("{", s), out = "";
      for (; i < src.length; i++) { const c = src[i]; if (c === "{") depth++; if (c === "}") { depth--; if (depth === 0) break; } if (depth === 1) out += c; }
      return [...out.matchAll(/^\s*([a-zA-Z0-9]+)\??:/gm)].map((m) => m[1]).sort();
    };
    const apiKeys = keysOf(api, "NoticeSnapshotData");
    assert.deepEqual(apiKeys, keysOf(web, "ArrivalNoticeSnapshotData"));
    const apiProduct = api.slice(api.indexOf("products: Array<{", api.indexOf("export interface NoticeSnapshotData")) + "products: Array<{".length, api.indexOf("}>;", api.indexOf("export interface NoticeSnapshotData")));
    assert.deepEqual([...apiProduct.matchAll(/^\s*([a-zA-Z0-9]+):/gm)].map((m) => m[1]).sort(), keysOf(web, "ArrivalNoticeProduct"));
    // snapshotDataOf 每一项都写了（少写一项存进去就是 undefined → JSON 里直接没有）
    const fn = api.slice(api.indexOf("export function snapshotDataOf"), api.indexOf("function parseSnapshotData"));
    for (const k of [...apiKeys, ...keysOf(web, "ArrivalNoticeProduct")]) assert.match(fn, new RegExp(`\\b${k}:`), `snapshotDataOf 没写 ${k}`);
  });

  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
