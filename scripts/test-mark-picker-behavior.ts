/**
 * 唛头下拉 MarkPicker 的「真跑」行为测试（2026-10-08 老板：唛头「换个方式显示，太丑了」→ 6 处唛头框换成 MarkPicker）。
 *
 * 做法照 test-cs-chat-ui-behavior：极简「假 React」把仓库里的真组件跑起来，直接调元素上的 onChange / onKeyDown / onClick。
 * 组件是受控的：value 由测试持有，onChange 回来改 props 再重画（跟页面一样）。
 *
 * 钉住的问题（审查 10-08，每条把修复改回去就红）：
 *   M1 打完 / 粘贴完一个完整唛头顺手按回车，被换成列表第一个人（6 处都中，可能把单挂到别人名下）
 *   M2 打到短账号「XPP-0015」正好完全一致时，列表变成全部客户，「XPP-0015 XHH-6698」被埋掉（前缀账号，老板 09 月立过规矩）
 *   M3 Safari 中文输入法上屏字母的回车（compositionend 先到、keydown 后到、keyCode 229）被当成「选第一项」
 *   M4 列表晚到（先打开、客户列表后加载）时，高亮归零、回车换成第一个人
 *   M5 只有用上下键明确挪过才算选中：上下键 + 回车能选；鼠标悬停不改高亮
 *   M6 点进已经选好唛头的框 / 点箭头：列全部、高亮并定位到现在的唛头
 *   M7 打到一半按回车不自动补全（不会停在短账号上）；点选项能选、选完收起；× 清空
 *   M8 右边留位：有字（有 ×）60，没字 34（窄格子里长唛头多露几个字）
 *   —— 第二轮审查（10-08）——
 *   M9 上下键选好以后，上层页面重新渲染（超管页每 10 秒自动刷新、调用方每次传新数组）：选择不作废，回车照样选上
 *   M10 页面原样式里的外边距（员工端 marginBottom）放到最外层，不放进输入框（会把 × 和箭头挤偏）
 *   M11 超管「创建订单」弹窗给够最小高度，下拉不被弹窗底边裁掉
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// ---------- 假 React（同 test-cs-chat-ui-behavior，补了 useId） ----------
let hooks: any[] = [];
let idx = 0;
let pendingLayout: Array<() => void> = [];
let pendingEffects: Array<() => void> = [];
let dirty = false;
let Comp: ((p: any) => any) | null = null;
let compProps: any = null;
let tree: any = null;
let idSeq = 0;

function depsChanged(a?: unknown[], b?: unknown[]) {
  if (!a || !b) return true;
  if (a.length !== b.length) return true;
  return a.some((x, i) => !Object.is(x, b[i]));
}
function effectHook(fn: any, deps: unknown[] | undefined, queue: Array<() => void>) {
  const i = idx++;
  const h = hooks[i];
  if (!h || depsChanged(h.deps, deps)) {
    const prevCleanup = h?.cleanup;
    hooks[i] = { deps, cleanup: undefined };
    queue.push(() => {
      if (typeof prevCleanup === "function") prevCleanup();
      hooks[i].cleanup = fn();
    });
  }
}
const FakeReact = {
  useState(init: any) {
    const i = idx++;
    if (!(i in hooks)) hooks[i] = { v: typeof init === "function" ? init() : init };
    const h = hooks[i];
    const set = (nv: any) => {
      const val = typeof nv === "function" ? nv(h.v) : nv;
      if (!Object.is(val, h.v)) { h.v = val; dirty = true; }
    };
    return [h.v, set];
  },
  useRef(init: any) {
    const i = idx++;
    if (!(i in hooks)) hooks[i] = { current: init };
    return hooks[i];
  },
  useMemo(fn: any, deps: unknown[]) {
    const i = idx++;
    if (!hooks[i] || depsChanged(hooks[i].deps, deps)) hooks[i] = { v: fn(), deps };
    return hooks[i].v;
  },
  useId() {
    const i = idx++;
    if (!(i in hooks)) hooks[i] = { v: `:r${++idSeq}:` };
    return hooks[i].v;
  },
  useEffect(fn: any, deps?: unknown[]) { effectHook(fn, deps, pendingEffects); },
  useLayoutEffect(fn: any, deps?: unknown[]) { effectHook(fn, deps, pendingLayout); },
};
const jsxRuntime = {
  jsx: (type: any, props: any, key?: any) => ({ type, props, key }),
  jsxs: (type: any, props: any, key?: any) => ({ type, props, key }),
  Fragment: "Fragment",
};
let focusCalls = 0;
function attachRefs(node: any) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach(attachRefs); return; }
  if (node.props?.ref && typeof node.props.ref === "object" && node.props.ref.current == null) {
    // input 的 focus()：真浏览器里会派发 focus 事件 → 走组件的 onFocus（还没聚焦时）
    const ref = node.props.ref;
    const isInput = node.type === "input";
    ref.current = {
      focus() { focusCalls++; if (isInput && !focused) { focused = true; findInput().props.onFocus?.({}); } },
      querySelector: () => ({ scrollIntoView() {} }),
    };
  }
  attachRefs(node.props?.children);
}
function renderOnce() {
  idx = 0;
  dirty = false;
  tree = Comp!(compProps);
  attachRefs(tree);
  const lay = pendingLayout; pendingLayout = [];
  lay.forEach((f) => f());
  const eff = pendingEffects; pendingEffects = [];
  eff.forEach((f) => f());
}
function flush() {
  let n = 0;
  while (dirty) { renderOnce(); if (++n > 50) throw new Error("render loop"); }
}
function findAll(pred: (n: any) => boolean, root?: any): any[] {
  const out: any[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type !== undefined && pred(node)) out.push(node);
    walk(node.props?.children);
  };
  walk(root === undefined ? tree : root);
  return out;
}

// ---------- 加载真组件 ----------
const SRC = path.join(process.cwd(), "apps/web/src");
function loadModule(abs: string): any {
  const out = ts.transpileModule(fs.readFileSync(abs, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: abs,
  }).outputText;
  const mod = { exports: {} as any };
  const req = (spec: string) => {
    if (spec === "react") return FakeReact;
    if (spec === "react/jsx-runtime") return jsxRuntime;
    if (spec.startsWith(".")) {
      const base = path.resolve(path.dirname(abs), spec);
      for (const ext of ["", ".ts", ".tsx"]) {
        const p = base + ext;
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return loadModule(p);
      }
    }
    throw new Error(`unmocked ${spec} from ${abs}`);
  };
  new Function("exports", "require", "module", out)(mod.exports, req, mod);
  return mod.exports;
}
const MarkPicker = loadModule(path.join(SRC, "modules/layout/MarkPicker.tsx")).default;

// ---------- 受控挂载 ----------
let value = "";
let focused = false;
const OPTS = ["AAA-0001", "BBB-0002", "XPP-0015", "CCC-0003", "XPP-0015 XHH-6698"].map((id) => ({ id }));
function mount(initial: string, options = OPTS, extra: Record<string, unknown> = {}) {
  hooks = []; pendingLayout = []; pendingEffects = []; idSeq = 0; focused = false; focusCalls = 0;
  value = initial;
  Comp = MarkPicker;
  compProps = { value, options, onChange: (v: string) => { value = v; compProps = { ...compProps, value: v }; dirty = true; }, ...extra };
  renderOnce();
  flush();
}
function setOptions(options: Array<{ id: string }>) { compProps = { ...compProps, options }; dirty = true; flush(); }
const findInput = () => findAll((n) => n.type === "input")[0];
const panelOpen = () => findAll((n) => typeof n.props?.className === "string" && n.props.className.includes("mark-picker-panel")).length > 0;
const rows = () => findAll((n) => n.type === "li" && n.props?.role === "option");
const rowIds = () => rows().map((r) => r.key);
const activeId = () => rows().find((r) => String(r.props.className).includes("is-active"))?.key ?? null;
function focus() { focused = true; findInput().props.onFocus({}); flush(); }
function type(text: string) { findInput().props.onChange({ target: { value: text } }); flush(); }
function key(k: string, nativeExtra: Record<string, unknown> = {}) {
  let prevented = false;
  findInput().props.onKeyDown({ key: k, nativeEvent: { isComposing: false, keyCode: k === "Enter" ? 13 : 0, ...nativeExtra }, preventDefault() { prevented = true; }, stopPropagation() {} });
  flush();
  return prevented;
}
function clickRow(id: string) {
  const r = rows().find((x) => x.key === id);
  assert.ok(r, `下拉里没有 ${id}`);
  r.props.onClick({});
  flush();
}
const button = (cls: string) => findAll((n) => n.type === "button" && String(n.props?.className).includes(cls))[0];

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`✅ ${name}`);
}

check("M1 打完完整唛头按回车：值不变（不会换成列表第一个人）；粘贴完整唛头再回车也一样", () => {
  mount("");
  focus();
  type("XPP-001");
  type("XPP-0015");
  assert.equal(key("Enter"), true, "下拉开着时回车要拦住（别提交外面的表单）");
  assert.equal(value, "XPP-0015", "回车把唛头换掉了");
  assert.equal(panelOpen(), false, "回车后要收起");
  // 粘贴：空框点进去直接粘贴
  mount("");
  focus();
  type("CCC-0003");
  key("Enter");
  assert.equal(value, "CCC-0003", "粘贴完整唛头再回车被换掉了");
  // 改到另一个完整的长账号再回车，不能被高亮残留拉回短账号
  mount("XPP-0015");
  focus();
  type("XPP-0015 XHH-6698");
  key("Enter");
  assert.equal(value, "XPP-0015 XHH-6698", "改成长账号后回车被拉回了短账号");
});

check("M2 打到短账号的完整唛头：列表仍按字筛，长账号还在眼前", () => {
  mount("");
  focus();
  type("XPP-0015");
  assert.deepEqual(rowIds(), ["XPP-0015", "XPP-0015 XHH-6698"], "打到短账号时列表变成全部客户了");
  assert.equal(activeId(), "XPP-0015", "高亮应在完全一致的那一行");
});

check("M3 Safari 输入法上屏字母的回车（keyCode 229）不算", () => {
  mount("");
  focus();
  type("xpp-001");
  assert.equal(key("Enter", { keyCode: 229 }), false);
  assert.equal(value, "xpp-001", "输入法的回车被当成选中了");
  assert.equal(panelOpen(), true, "输入法的回车不该收起下拉");
  key("Enter", { isComposing: true });
  assert.equal(value, "xpp-001");
});

check("M4 客户列表晚到：高亮不归零，回车不换人", () => {
  mount("XPP-0015", []);
  focus();
  setOptions(OPTS);
  assert.notEqual(activeId(), "AAA-0001");
  key("Enter");
  assert.equal(value, "XPP-0015", "列表晚到后回车换成了第一个人");
});

check("M5 上下键挪过再回车才换；鼠标悬停不改高亮", () => {
  mount("");
  focus();
  type("XPP");
  key("ArrowDown");
  assert.equal(activeId(), "XPP-0015");
  key("ArrowDown");
  assert.equal(activeId(), "XPP-0015 XHH-6698");
  key("Enter");
  assert.equal(value, "XPP-0015 XHH-6698", "上下键选的那一行没选上");
  assert.equal(panelOpen(), false);
  mount("");
  focus();
  assert.ok(rows().every((r) => r.props.onMouseEnter === undefined && r.props.onMouseMove === undefined), "鼠标悬停不许改键盘高亮（列表弹在鼠标底下，回车会选到那一行）");
});

check("M6 点进已选好唛头的框 / 点箭头：列全部，高亮定位到现在的唛头；回车不变", () => {
  mount("XPP-0015");
  focus();
  assert.deepEqual(rowIds(), OPTS.map((o) => o.id), "点进已选好的框要列全部（方便换人）");
  assert.equal(activeId(), "XPP-0015", "要高亮现在的唛头");
  key("Enter");
  assert.equal(value, "XPP-0015");
  // 打到一半时点箭头：也列全部
  mount("");
  focus();
  type("CC");
  assert.deepEqual(rowIds(), ["CCC-0003"]);
  button("mark-picker-toggle").props.onClick({});
  flush();
  button("mark-picker-toggle").props.onClick({});
  flush();
  assert.equal(panelOpen(), true);
  assert.deepEqual(rowIds(), OPTS.map((o) => o.id), "点箭头要列全部");
});

check("M7 打到一半回车不补全；点选项能选、选完收起；× 清空", () => {
  mount("");
  focus();
  type("XPP-001");
  key("Enter");
  assert.equal(value, "XPP-001", "打到一半回车被自动补成了某个账号（会停在短账号上）");
  focus();
  type("BBB");
  clickRow("BBB-0002");
  assert.equal(value, "BBB-0002");
  assert.equal(panelOpen(), false, "点完选项要收起");
  button("mark-picker-clear").props.onClick({});
  flush();
  assert.equal(value, "", "× 没清空");
});

check("M8 右边留位：有字 60、没字 34；带上页面原来的样式", () => {
  mount("", OPTS, { inputStyle: { border: "1px solid red", padding: "8px 10px" } });
  assert.equal(findInput().props.style.paddingRight, 34);
  assert.equal(findInput().props.style.border, "1px solid red");
  type("AAA-0001");
  assert.equal(findInput().props.style.paddingRight, 60);
  mount("", OPTS);
  assert.equal(findInput().props.style.paddingRight, 34, "没传页面样式时也要留位");
});

check("M9 上下键选好后上层重新渲染（传进内容一样的新数组）：选择不作废，回车照样选上", () => {
  mount("");
  focus();
  type("XPP");
  key("ArrowDown");
  key("ArrowDown");
  assert.equal(activeId(), "XPP-0015 XHH-6698");
  setOptions(OPTS.map((o) => ({ ...o }))); // 超管页 10 秒刷新：clientList.map(...) 每次都是新数组
  assert.equal(activeId(), "XPP-0015 XHH-6698", "上层一刷新，键盘选的那一行就没了");
  key("Enter");
  assert.equal(value, "XPP-0015 XHH-6698", "刷新后回车没选上");
  // 列表真变了、选的那个唛头没了：回车只收起，不乱选
  mount("");
  focus();
  type("XPP");
  key("ArrowDown");
  setOptions(OPTS.filter((o) => o.id !== "XPP-0015"));
  key("Enter");
  assert.equal(value, "XPP", "选的唛头已经不在列表里，回车不能换成别的");
});

check("M10 页面原样式里的外边距放到最外层，不放进输入框", () => {
  mount("", OPTS, { inputStyle: { border: "1px solid red", marginBottom: 8, padding: "6px 8px" } });
  assert.equal(findInput().props.style.marginBottom, undefined, "外边距进了输入框（× 和箭头会偏）");
  const wrapper = findAll((n) => typeof n.props?.className === "string" && n.props.className.startsWith("mark-picker") && n.props.className.split(" ")[0] === "mark-picker")[0];
  assert.equal(wrapper.props.style.marginBottom, 8, "外边距没挪到最外层");
  assert.equal(findInput().props.style.border, "1px solid red");
});

check("M11 超管「创建订单」弹窗给够最小高度（下拉不被底边裁掉）", () => {
  const admin = fs.readFileSync(path.join(process.cwd(), "apps/web/src/app/admin/page.tsx"), "utf8");
  const at = admin.indexOf("<MarkPicker value={createForm.clientId}");
  assert.ok(at > 0);
  const modalOpen = admin.lastIndexOf("maxWidth: 640", at);
  assert.ok(modalOpen > 0 && at - modalOpen < 1500);
  assert.match(admin.slice(modalOpen, modalOpen + 300), /minHeight: "min\(480px, 85vh\)"/, "超管创建订单弹窗没给最小高度，下拉会被裁");
});

console.log(`\n唛头下拉（MarkPicker）${passed} 项全部通过`);
