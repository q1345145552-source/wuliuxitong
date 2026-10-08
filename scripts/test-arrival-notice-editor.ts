/** 真跑 NoticeEditor（假 React 调真实控件），不连库；浏览器走查不能由这份代替。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import { readNoticeFields } from "../apps/api/src/modules/arrival-notices/routes";
import { draftToBody } from "../apps/web/src/services/arrival-notice-api";

let hooks: any[] = [], index = 0, effects: Array<() => void> = [], dirty = false, tree: any;
let props: any, saved = false, submitted: any;
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
};
const runtime = { jsx: (type: any, props: any, key: any) => ({ type, props, key }), jsxs: (type: any, props: any, key: any) => ({ type, props, key }) };
const file = path.resolve("apps/web/src/modules/arrival-notice/ArrivalNoticesView.tsx");
const realRequire = createRequire(file);
const out = ts.transpileModule(fs.readFileSync(file, "utf8") + "\nexport { NoticeEditor };", {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: file,
}).outputText;
const mod = { exports: {} as any };
new Function("exports", "require", "module", out)(mod.exports, (id: string) => {
  if (id === "react") return fakeReact;
  if (id === "react/jsx-runtime") return runtime;
  const real = realRequire(id);
  if (id === "../../services/arrival-notice-api") return { ...real, saveArrivalNotice: async (_id: unknown, draft: any) => {
    submitted = draftToBody(draft);
    const parsed = readNoticeFields(submitted);
    if ("error" in parsed) throw new Error(parsed.error);
    return { item: { ...parsed.fields, id: "zz-editor", images: [], notifiedAt: null, prealertMatches: [] } };
  } };
  return real;
}, mod);
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
function input(label: string, root = tree): any {
  const l = nodes((n) => n.type === "label" && text(n).startsWith(label), root)[0];
  assert.ok(l, `找不到 ${label}`);
  return nodes((n) => n.type === "input" || n.type === "textarea", l)[0];
}
function change(label: string, value: string, root = tree) { input(label, root).props.onChange({ target: { value } }); flush(); }
function mount(products?: any[], volumeM3 = 0.065) {
  hooks = []; effects = []; saved = false; submitted = null;
  props = {
    editor: products ? { mode: "edit", item: { id: "zz-editor", clientId: null, trackingNo: null, products, weightKg: 300, volumeM3, images: [], notifiedAt: null } } : { mode: "create" },
    clients: [], clientsFailed: false, onClose() {}, onChanged() {}, onSaved() { saved = true; },
  };
  flush();
}
const product = (overrides: any = {}) => ({ itemName: "灯具", packageCount: 1, lengthCm: 51, widthCm: 41, heightCm: 31, weightKg: null, productQuantity: null, cargoType: "normal", domesticTrackingNo: null, ...overrides });
async function settleSave() { await new Promise<void>((resolve) => setImmediate(resolve)); flush(); }
async function main() {
  // 编辑已存为三位的通知，只改备注也必须能存；保存过程中真实表单全部锁住。
  mount([product()]);
  assert.equal(input("总体积").props.value, "0.065");
  assert.equal(input("总体积").props.readOnly, true);
  change("备注", "只改备注");
  const saveButton = nodes((n) => n.type === "button" && text(n) === "保存")[0];
  assert.ok(saveButton, "找不到保存按钮");
  const pending = saveButton.props.onClick(); flush();
  const form = nodes((n) => n.props?.className === "an-form")[0];
  assert.ok(nodes((n) => ["input", "select", "textarea", "button"].includes(n.type), form).every((n) => n.props.disabled));
  await pending; await settleSave();
  assert.equal(saved, true, text(tree));
  assert.equal(submitted.volumeM3, "0.065");
  assert.equal(submitted.remark, "只改备注");
  console.log("✅ E1 修改旧通知：自动三位体积、只读、保存成功、保存中锁表单");

  mount();
  change("品名", "小样"); change("件数", "1");
  change("长", "5"); change("宽", "5"); change("高", "5");
  assert.equal(input("总体积").props.value, "0.000");
  await nodes((n) => n.type === "button" && text(n) === "保存")[0].props.onClick(); await settleSave();
  assert.equal(saved, true, text(tree));
  console.log("✅ E2 新登记小样：自动体积舍成 0.000 仍能保存");

  mount([product({ packageCount: 12, weightKg: 5 }), product({ itemName: "鞋", packageCount: 5, lengthCm: null, widthCm: null, heightCm: null })]);
  assert.equal(input("总重量").props.value, "60.00");
  assert.match(text(tree), /第 2 款没填单箱重，总重量只算了其余几款/);
  assert.match(text(tree), /第 2 款没填齐长宽高，总体积只算了其余几款/);
  const first = nodes((n) => n.props?.className === "an-prod")[0];
  change("单箱重", "", first);
  assert.equal(input("总重量").props.value, "");
  assert.equal(input("总重量").props.readOnly, false);
  change("总重量", "300");
  assert.equal(input("总重量").props.value, "300");
  assert.ok(!text(tree).includes("总重量只算了其余几款"));
  console.log("✅ E3 部分款未计入的提示真出现，清空单箱重解锁手填");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
