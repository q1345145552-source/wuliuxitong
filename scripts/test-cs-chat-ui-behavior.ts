/**
 * 客服对话页面的「真跑」回归（2026-09-28 上线前分支审查补）：不起浏览器，把**仓库里的真组件**跑起来点。
 *
 * 做法（审查员 B 在审查时搭的，原样收进来）：
 *   · 一个极简「假 React」（useState / useRef / useCallback / useMemo / useEffect / useLayoutEffect），
 *     渲染出 {type, props} 树，测试直接找元素调它的 onChange / onKeyDown / onClick；
 *   · ChatThread.tsx、staff/chat/page.tsx、cs-chat-api.ts（含 mergeChatMessages）、request-gate 全是真代码（ts 转译后跑）；
 *   · 只换掉网络（core-api 的 apiRequest，改成手动放行的假请求）、压图（image-compress）和 next/navigation。
 *
 * 钉住的 bug（每条都是「把修复改回去就红」）：
 *   U1 发送途中接着打的字，第一条发成功后被整框清空；没发出去要把原话放回来
 *   U2 Safari 的输入法回车顺序（compositionend 先到、keydown 后到、keyCode 229）会把拼音字母发出去
 *   U3 发送中粘贴截图被悄悄吞掉，没有任何提示
 *   U4 第一次取消息失败后窗口是死的：没有重试、轮询不启动（现在有「重试」，5 秒后自己再试，最多 3 次）
 *   U5 轮询断了几秒、恢复后赶在下一轮前自己发了一句，对方那几秒的消息永远不出来（轮询起点不能跟着自己发的走）
 *   U6 员工在「搜唛头」里一过滤，已划给代理的客户窗口「不能再发」的提示就没了
 *   U7 手机上正聊着某个客户、点菜单「客户消息」（网址变回 /staff/chat）回不到列表
 *   —— 整柜询价报价弹窗（components/client/FclInquiryPanel.tsx，同一套假 React）——
 *   U8 同一张单上一次报价还没回来：关了又打开，不许再报（原来能再点，两次请求谁先到库说不准，旧价会盖掉新价）
 *   U9 报价晚回来：刷新的是「现在这一页」列表，不会把员工翻到的第 2 页拽回第 1 页；详情关了也照样提示成败
 *   U10 询价记录要手点「加载记录」才出来（2026-09-29 老板报「每次都要点加载才能出来」）：切到这一栏就自己拉、
 *       切回来重拉、藏着时不发请求；加载失败点一下「重试」就真去拉（原来要点两次）
 *   —— 2026-10-02 老板：「直接显示已读，每条信息都显示，类似 LINE 那种。然后每个信息都单独显示时间」「还要有消息提示音」——
 *   U11 我方发的、对方看过的写「已读」（客户那头 / 客服那头，别的员工发的也算我方）；对方的从来不写；对方一看，下一轮就变
 *   U12 每条都有时间（北京时间）；跨天插一行日期（UTC 16:30 = 北京第二天 00:30，要归到第二天）
 *   U13 提示音：打开对话时的旧消息不响；轮询来了对方新消息响一次；同一条再带回来不响；我方自己发的、别的员工发的不响
 *   U14 菜单未读：第一次取回来不响（打开网页前就有的）；有更新的才响；聊天窗口已经为这条响过就不再响；网页切到后台也照样问
 *   —— dsh 复查（2026-10-02）——
 *   U15 浏览器窗口不是当前窗口（人在别的软件里）：不标已读；点回这个窗口马上标
 *   U16 1 秒内来了两条不同的新消息：第二声不丢，等满 1 秒补响
 *   U17 开着好几个标签页：别的标签页已经为这条响过（或者在那边已经看到了），这边不再响
 *   U18 页面开着过了零点：日期行自己从「今天」变「昨天」，不用等新消息
 *   —— dsh 第二轮复查（2026-10-02）——
 *   U17 改成按对话记：客户甲刚响过，客户乙更早、没人看过的那条照样响（原来一个全局时间，一比就当「报过了」）
 *   U19 换对话那一瞬间窗口获得焦点：不会拿上一个客户的消息时间去标下一个客户的已读
 *   —— dsh 第三轮复查（2026-10-02）——
 *   U14 补客户那头的菜单；U17 补「共用记录写满时刚写进去的那条要留下」「唛头叫 __proto__ 也照样响」
 *   U20 员工聊天页的客户列表（5 秒刷一次）：正开着客户甲聊天时客户乙来了新消息，跟着列表就响，不用等菜单那 30 秒
 *   U21 老板 10-02：「当时收的时候响，而不是之后响」—— 菜单未读在眼前 5 秒问一次（原来 30 秒）；计时放在 Worker 里
 *       （后台久了浏览器会把页面自己的定时器放慢到一分钟一次）；Worker 起不来就退回页面定时器；关页面时 Worker 关掉；
 *       真把 public/chat-tick.worker.js 跑一遍（原来只测了假 Worker，文件改成空的也照样绿）
 *   —— Codex 复查（2026-10-02）——
 *   U20 改：员工聊天页的客户列表不再报提示音（跟菜单抢「第一次只记不响」，会把真新消息吞掉）；菜单照样响
 *   U22 服务器慢（一次超过 5 秒）：上一次没回来不发新的，回来了不被作废；中途要求刷新的回来后补问一次
 *   U23 员工菜单只报最近 50 个：打开网页前就有、后来才排进 50 个的旧未读不响；退出 / 换人登录时清掉提示音记录
 *   —— Codex 第二轮复查（2026-10-02）——
 *   U22 补：第一次问未读很慢、这期间对方发来的消息跟着第一次结果回来 → 照样响一次（原来第一次结果一律只记不响）；
 *       补问回来同一条不再响；打开网页前 10 秒以外就有的不响
 *   —— 2026-10-02 老板：「这几个都可以做」+「可以选择是哪个运单…整柜的也可以」——
 *   U24 撤回：自己的、按服务器的钟 2 分钟内才有按钮，过了自己消失；点了变「你撤回了一条消息」
 *   U25 对方撤回：轮询带回同一条（已撤回），这边换成「客服 撤回了一条消息」；发了马上撤回的不响
 *   U26 选运单：列客户自己的运单 / 整柜（客服那头带上唛头）、搜索交给后端；选了出「关于：…」；只发单子不打字也能发；
 *       发出去才去掉，没发出去留着
 *   U27 气泡里的单子卡片：单号、品名、现在的状态（客户看 delivered 叫「已签收」）；删了的写清楚；状态变了跟着变
 *   U28 员工「客户消息」：「全部 / 待回复」页签、待回复写等了多久、摘要「我方：」按最新一条还在的算
 *   U29 浏览器系统通知（chat-push.ts）：开 → 交给后端、记下是谁开的；换人登录 → 退掉；退出登录先在浏览器退掉再告诉后端；
 *       服务器没配 / 被禁止 / 不支持各自的状态
 *   U29b 推送服务连不上（国内 Chrome 连不上谷歌，一直不回）：20 秒后报中文；无痕窗口的英文报错也换成中文
 *   U30 push-sw.js 真跑：人正对着网页不弹（苹果照弹）；同一对话互相替换；点通知切到已开的窗口、只认本站地址
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const SRC = path.join(process.cwd(), "apps/web/src");

// ---------- 假 React ----------
let hooks: any[] = [];
let idx = 0;
let pendingLayout: Array<() => void> = [];
let pendingEffects: Array<() => void> = [];
let dirty = false;
let Comp: ((p: any) => any) | null = null;
let compProps: any = null;
let tree: any = null;

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
  useCallback(fn: any, deps: unknown[]) {
    const i = idx++;
    if (!hooks[i] || depsChanged(hooks[i].deps, deps)) hooks[i] = { fn, deps };
    return hooks[i].fn;
  },
  useMemo(fn: any, deps: unknown[]) {
    const i = idx++;
    if (!hooks[i] || depsChanged(hooks[i].deps, deps)) hooks[i] = { v: fn(), deps };
    return hooks[i].v;
  },
  useEffect(fn: any, deps?: unknown[]) { effectHook(fn, deps, pendingEffects); },
  useLayoutEffect(fn: any, deps?: unknown[]) { effectHook(fn, deps, pendingLayout); },
  Suspense: "Suspense",
};
const jsxRuntime = {
  jsx: (type: any, props: any, key?: any) => ({ type, props, key }),
  jsxs: (type: any, props: any, key?: any) => ({ type, props, key }),
  Fragment: "Fragment",
};
function attachRefs(node: any) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach(attachRefs); return; }
  if (node.props?.ref && typeof node.props.ref === "object" && node.props.ref.current == null) {
    node.props.ref.current = { scrollHeight: 1000, scrollTop: 600, clientHeight: 400, click() {} };
  }
  attachRefs(node.props?.children);
}
/** 按住 useEffect 不跑（useLayoutEffect 照跑）：模拟真 React「新的一帧已经画了、passive effect 还没跑」那个空档 */
let holdEffects = false;
function runHeldEffects() {
  holdEffects = false;
  const eff = pendingEffects; pendingEffects = [];
  eff.forEach((f) => f());
  flush();
}
function renderOnce() {
  idx = 0;
  dirty = false;
  tree = Comp!(compProps);
  attachRefs(tree);
  const lay = pendingLayout; pendingLayout = [];
  lay.forEach((f) => f());
  if (holdEffects) return;
  const eff = pendingEffects; pendingEffects = [];
  eff.forEach((f) => f());
}
function flush() {
  let n = 0;
  while (dirty) { renderOnce(); if (++n > 50) throw new Error("render loop"); }
}
/** 外部条件变了（比如网址）要求重画一次 */
function rerender() { dirty = true; flush(); }
function mount(c: (p: any) => any, p: any) {
  hooks = []; pendingLayout = []; pendingEffects = []; Comp = c; compProps = p;
  renderOnce();
  flush();
}
function unmount() {
  for (const h of hooks) if (h && typeof h.cleanup === "function") h.cleanup();
  hooks = [];
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
function textOf(node: any): string {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.props?.children);
}

// ---------- 假网络 ----------
type Call = { url: string; opts: any; resolve: (v: any) => void; reject: (e: any) => void; done?: boolean };
const calls: Call[] = [];
const fakeCoreApi = {
  apiBaseUrl: () => "",
  apiRequest: (url: string, opts: any = {}) => new Promise((resolve, reject) => { calls.push({ url, opts, resolve, reject }); }),
};
const fakeImageCompress = {
  compressImageForUpload: async (f: any) => ({ fileName: f.name ?? "a.png", mime: "image/png", base64: "AAAA" }),
};

// ---------- 假浏览器 ----------
const timers: Array<{ id: number; fn: () => void; ms: number; alive: boolean; once: boolean }> = [];
let tid = 0;
const listeners: Record<string, Array<(e: any) => void>> = {};
const docListeners: Record<string, Array<(e: any) => void>> = {};
const fakeDocument: any = {
  visibilityState: "visible",
  addEventListener: (t: string, f: any) => { (docListeners[t] ??= []).push(f); },
  removeEventListener: (t: string, f: any) => { docListeners[t] = (docListeners[t] ?? []).filter((x) => x !== f); },
};
const fakeWindow: any = {
  setInterval: (fn: () => void, ms: number) => { const id = ++tid; timers.push({ id, fn, ms, alive: true, once: false }); return id; },
  clearInterval: (id: number) => { const t = timers.find((x) => x.id === id); if (t) t.alive = false; },
  setTimeout: (fn: () => void, ms: number) => { const id = ++tid; timers.push({ id, fn, ms, alive: true, once: true }); return id; },
  clearTimeout: (id: number) => { const t = timers.find((x) => x.id === id); if (t) t.alive = false; },
  addEventListener: (t: string, f: any) => { (listeners[t] ??= []).push(f); },
  removeEventListener: (t: string, f: any) => { listeners[t] = (listeners[t] ?? []).filter((x) => x !== f); },
  dispatchEvent: (e: any) => { (listeners[e.type] ?? []).slice().forEach((f) => f(e)); return true; },
  location: { search: "", pathname: "/staff/chat", hash: "" },
  history: { replaceState: (_s: any, _u: any, url: string) => { const u = new URL(url, "http://x"); fakeWindow.location.search = u.search; fakeWindow.location.pathname = u.pathname; } },
};
(globalThis as any).window = fakeWindow;
(globalThis as any).document = fakeDocument;
(globalThis as any).requestAnimationFrame = (f: () => void) => { f(); return 0; };
const aliveTimers = () => timers.filter((t) => t.alive);
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); flush(); }
/** 到点：所有活着的定时器各跑一次（setTimeout 跑完就死） */
async function tickTimers(filter: (t: { ms: number; once: boolean }) => boolean = () => true) {
  for (const t of aliveTimers().filter(filter)) { if (t.once) t.alive = false; t.fn(); }
  await settle();
}

// ---------- 模块加载（真代码） ----------
const modCache = new Map<string, any>();
function loadModule(abs: string, overrides: Record<string, any>): any {
  if (modCache.has(abs)) return modCache.get(abs).exports;
  const out = ts.transpileModule(fs.readFileSync(abs, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: abs,
  }).outputText;
  const mod = { exports: {} as any };
  modCache.set(abs, mod);
  const req = (spec: string) => {
    if (spec in overrides) return overrides[spec];
    if (spec === "react") return FakeReact;
    if (spec === "react/jsx-runtime") return jsxRuntime;
    if (spec.startsWith(".")) {
      const base = path.resolve(path.dirname(abs), spec);
      for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        const p = base + ext;
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p in overrides ? overrides[p] : loadModule(p, overrides);
      }
      throw new Error(`cannot resolve ${spec} from ${abs}`);
    }
    throw new Error(`unmocked external ${spec} from ${abs}`);
  };
  new Function("exports", "require", "module", out)(mod.exports, req, mod);
  return mod.exports;
}
const OVERRIDES: Record<string, any> = {
  [path.join(SRC, "services/core-api.ts")]: fakeCoreApi,
  [path.join(SRC, "modules/shared/image-compress.ts")]: fakeImageCompress,
  "next/navigation": { useSearchParams: () => new URLSearchParams(fakeWindow.location.search) },
};

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
  finally { unmount(); calls.length = 0; timers.length = 0; }
}

async function main(): Promise<void> {
  const ChatThread = loadModule(path.join(SRC, "modules/cs-chat/ChatThread.tsx"), OVERRIDES).default;
  const ta = () => findAll((n) => n.type === "textarea")[0];
  const msg = (id: string, mine: boolean, t: string, content = id) => ({ id, side: mine ? "client" : "cs", mine, senderLabel: mine ? "我" : "客服", content, imageUrl: null, createdAt: t });
  const lastCall = () => calls[calls.length - 1];
  const enter = (keyCode = 13, isComposing = false) =>
    ta().props.onKeyDown({ key: "Enter", shiftKey: false, nativeEvent: { isComposing, keyCode }, preventDefault() {} });
  const sendCalls = () => calls.filter((c) => c.url.includes("/chat/send"));
  async function boot() {
    mount(ChatThread, { scope: { kind: "client" }, title: "客服" });
    lastCall().resolve({ messages: [msg("a1", false, "2026-09-28T01:00:00.000Z")], hasMore: false, serverTime: "2026-09-28T01:00:05.000Z" });
    await settle();
  }

  await check("U1 按回车后输入框马上清空；发送途中接着打的字，发成功后还在；没发出去，原话放回来", async () => {
    await boot();
    ta().props.onChange({ target: { value: "第一条" } }); flush();
    enter(); flush();
    assert.equal(sendCalls().length, 1);
    assert.equal(ta().props.value, "", "按了发送输入框没清空");
    ta().props.onChange({ target: { value: "第二句还没打完" } }); flush();
    sendCalls()[0].resolve({ message: msg("m1", true, "2026-09-28T01:00:06.000Z", "第一条") });
    await settle();
    assert.equal(ta().props.value, "第二句还没打完", "第一条发成功后把后打的字清掉了");
    // 没发出去：框里空着就把原话放回来
    ta().props.onChange({ target: { value: "会失败的一句" } }); flush();
    enter(); flush();
    sendCalls()[1].reject(new Error("网络断了"));
    await settle();
    assert.equal(ta().props.value, "会失败的一句", "没发出去，原话没放回来");
    assert.ok(findAll((n) => n.props?.role === "alert").map(textOf).some((t) => t.includes("没发出去")), "没发出去没提示");
    // 没发出去、可框里已经接着打了下一句：两句都要留着（原话放前面），不能把没发出去那句丢了（Codex 复看第 7 条）
    ta().props.onChange({ target: { value: "又一句会失败的" } }); flush();
    enter(); flush();
    ta().props.onChange({ target: { value: "已经在打的下一句" } }); flush();
    sendCalls()[2].reject(new Error("网络又断了"));
    await settle();
    assert.equal(ta().props.value, "又一句会失败的\n已经在打的下一句", `没发出去那句丢了：${JSON.stringify(ta().props.value)}`);
  });

  await check("U2 输入法回车：Chrome 顺序、Safari 顺序（compositionend 先到、keydown 后到、keyCode 229）都不发送", async () => {
    await boot();
    ta().props.onCompositionStart(); ta().props.onChange({ target: { value: "nihao" } }); flush();
    enter(229, true);
    ta().props.onCompositionEnd(); flush();
    assert.equal(sendCalls().length, 0, "Chrome 顺序：选字的回车被当成发送");
    ta().props.onCompositionStart(); flush();
    ta().props.onCompositionEnd(); flush();
    enter(229, false); flush();
    assert.equal(sendCalls().length, 0, `Safari 顺序：选字的回车把「${ta().props.value}」发出去了`);
    enter(13, false); flush();
    assert.equal(sendCalls().length, 1, "正常回车反而发不出去了");
  });

  await check("U3 发送中粘贴截图：给出提示，不悄悄吞掉", async () => {
    await boot();
    ta().props.onChange({ target: { value: "看这个" } }); flush();
    enter(); flush();
    const n0 = calls.length;
    ta().props.onPaste({ clipboardData: { files: [{ type: "image/png", name: "shot.png" }] }, preventDefault() {} });
    await settle();
    assert.equal(calls.length, n0, "发送中又发了一个请求");
    const alerts = findAll((n) => n.props?.role === "alert").map(textOf);
    assert.ok(alerts.some((t) => t.includes("上一条还在发送")), `没提示：${JSON.stringify(alerts)}`);
  });

  await check("U4 第一次取消息失败：有「重试」按钮、点了重取；5 秒后自己重试，最多 3 次", async () => {
    mount(ChatThread, { scope: { kind: "client" }, title: "客服" });
    lastCall().reject(new Error("网络连接异常"));
    await settle();
    const retry = findAll((n) => n.type === "button" && textOf(n) === "重试")[0];
    assert.ok(retry, "出错了没有「重试」按钮");
    const n0 = calls.length;
    retry.props.onClick(); await settle();
    assert.equal(calls.length, n0 + 1, "点「重试」没有重新取");
    lastCall().reject(new Error("还是不通")); await settle();
    // 自己重试：5 秒一次，最多 3 次
    let auto = 0;
    for (let i = 0; i < 6; i++) {
      const before = calls.length;
      await tickTimers((t) => t.once && t.ms === 5000);
      if (calls.length > before) { auto++; lastCall().reject(new Error("不通")); await settle(); }
    }
    assert.equal(auto, 3, `自己重试了 ${auto} 次，应该正好 3 次`);
    // 网络好了：点重试能恢复，轮询也起来
    findAll((n) => n.type === "button" && textOf(n) === "重试")[0].props.onClick(); await settle();
    lastCall().resolve({ messages: [msg("a1", false, "2026-09-28T01:00:00.000Z")], hasMore: false, serverTime: "2026-09-28T01:00:05.000Z" });
    await settle();
    assert.equal(ta().props.disabled, false, "恢复后输入框还是灰的");
    assert.ok(aliveTimers().some((t) => !t.once && t.ms === 3000), "恢复后没开始轮询");
  });

  await check("U5 轮询起点不跟着自己发的那条走：断了一阵、恢复后先发了一句，下一轮照样从对方最后一条之后取", async () => {
    await boot();
    ta().props.onChange({ target: { value: "我先说一句" } }); flush();
    enter(); flush();
    sendCalls()[0].resolve({ message: msg("m1", true, "2026-09-28T01:00:20.000Z", "我先说一句") });
    await settle();
    await tickTimers((t) => !t.once && t.ms === 3000);
    const poll = calls.filter((c) => c.url.includes("/client/chat/messages") && c.url.includes("since=")).pop();
    assert.ok(poll, "没发轮询请求");
    const since = new URL(poll!.url, "http://x").searchParams.get("since");
    assert.equal(since, "2026-09-28T01:00:00.000Z", `轮询起点跳到了自己刚发的那条（${since}），对方这中间发的会落在「往前多取 5 秒」之外`);
  });

  // ---------- 员工「客户消息」 ----------
  function ThreadStub(_p: any) { return null; }
  const stubMod = { __esModule: true, default: ThreadStub, CHAT_UNREAD_EVENT: "xt-chat-unread-changed" };
  const pageMod = loadModule(path.join(SRC, "app/staff/chat/page.tsx"), { ...OVERRIDES, [path.join(SRC, "modules/cs-chat/ChatThread.tsx")]: stubMod });
  // 页面默认导出外面包了一层 Suspense（Next 16 用 useSearchParams 的规矩）：取出里面那个组件直接跑
  const outer = pageMod.default();
  const Inbox = outer.props.children.type;
  assert.equal(typeof Inbox, "function", "页面结构变了：Suspense 里面不是一个组件");
  const conv = (clientId: string, closed: boolean) => ({ clientId, lastMessageAt: "2026-09-28T01:00:00.000Z", lastMessagePreview: "hi", lastFromClient: true, unreadCount: 1, closed });
  const thread = () => findAll((n) => n.type === ThreadStub)[0];
  async function answerList(items: any[]) {
    for (const c of calls.filter((x) => x.url.includes("/staff/chat/conversations") && !x.done)) { c.done = true; c.resolve({ items, truncated: false }); }
    await settle();
  }

  await check("U6 已划给代理的客户：搜索框把它过滤掉以后，右边窗口照样是「只能看、不能发」", async () => {
    fakeWindow.location.search = "";
    mount(Inbox, {});
    await answerList([conv("AGT01", true), conv("BB02", false)]);
    findAll((n) => n.type === "button" && n.key === "AGT01")[0].props.onClick(); flush();
    assert.ok(thread()?.props.closedNotice, "选中已划走的客户，没有「不能再发」提示");
    findAll((n) => n.type === "input" && n.props["aria-label"] === "搜唛头")[0].props.onChange({ target: { value: "BB" } }); flush();
    await answerList([conv("BB02", false)]);
    assert.equal(thread()?.props.scope.clientId, "AGT01");
    assert.ok(thread()?.props.closedNotice, "一搜索，「不能再发」提示没了（输入框又冒出来）");
  });

  await check("U7 网址带 ?clientId= 打开那个客户；点菜单「客户消息」（网址变回 /staff/chat）回到列表", async () => {
    fakeWindow.location.search = "?clientId=BB02";
    mount(Inbox, {});
    await answerList([conv("BB02", false)]);
    assert.equal(thread()?.props.scope.clientId, "BB02", "网址带的客户没打开");
    fakeWindow.location.search = "";
    rerender(); await settle();
    assert.equal(thread(), undefined, "网址已经回到 /staff/chat，屏幕还停在那个客户的聊天");
  });

  // ---------- 整柜询价报价弹窗 ----------
  const toasts: string[] = [];
  function ModalStub(_p: any) { return null; }
  const panelMod = loadModule(path.join(SRC, "components/client/FclInquiryPanel.tsx"), {
    ...OVERRIDES,
    "next/link": { __esModule: true, default: "a" },
    [path.join(SRC, "auth/auth-session.ts")]: { getOptionalSession: () => ({ role: "staff", userId: "s1", companyId: "c1", token: "t" }) },
    [path.join(SRC, "modules/branding/useWorkbenchBrand.ts")]: { useCurrentSessionBrand: () => null },
    [path.join(SRC, "modules/layout/DetailModal.tsx")]: { __esModule: true, default: ModalStub },
  });
  const Panel = panelMod.default;
  const inquiry = (id: string) => ({
    id, clientId: "C1", productName: "鞋", cargoValue: "1万", cargoWeight: "5吨", address: "曼谷", containerType: "1*40HQ",
    serviceType: "清提派", loadingDate: null, certFileName: null, status: "pending", createdAt: "2026-09-28T01:00:00.000Z",
    quoteAmountCny: null, quoteNote: null, quotedAt: null, acceptedAt: null, convertedAt: null, fclContainerId: null, fclDeleted: false,
  });
  const listCalls = () => calls.filter((c) => c.url.includes("/client/fcl-inquiries?"));
  const detailCalls = () => calls.filter((c) => c.url.includes("/client/fcl-inquiries/detail"));
  const quoteCalls = () => calls.filter((c) => c.url.includes("/staff/fcl-inquiries/quote"));
  const btn = (label: string) => findAll((n) => n.type === "button" && textOf(n).trim() === label);
  const modal = () => findAll((n) => n.type === ModalStub)[0];
  async function openPanelAndDetail() {
    toasts.length = 0;
    mount(Panel, { visible: true, isStaff: true, onToast: (m: string) => toasts.push(m) });
    await settle(); // 一打开就自己拉列表（U10），不用再点「加载记录」
    // 共 120 条（第 1 页 50 条），这里只放一条，够点「详情 / 报价」
    listCalls().pop()!.resolve({ items: [inquiry("A")], total: 120 }); await settle();
    btn("详情 / 报价")[0].props.onClick(); await settle();
    detailCalls().pop()!.resolve({ ...inquiry("A"), certFileBase64: null, productImages: [] }); await settle();
  }
  const typeAmount = (v: string) => {
    const input = findAll((n) => n.type === "input" && n.props.placeholder === "如 18000")[0];
    assert.ok(input, "详情里没有报价金额输入框");
    input.props.onChange({ target: { value: v } }); flush();
  };
  const quoteBtn = () => findAll((n) => n.type === "button" && /^(报价|改报价|保存中…)$/.test(textOf(n).trim()))[0];

  await check("U8 同一张单上一次报价还没回来：关了又打开，报价按钮是「保存中…」、点了也不发第二次", async () => {
    await openPanelAndDetail();
    typeAmount("100");
    quoteBtn().props.onClick(); await settle();
    assert.equal(quoteCalls().length, 1);
    modal().props.onClose(); flush();                       // 关掉
    btn("详情 / 报价")[0].props.onClick(); await settle();    // 又打开同一张
    detailCalls().pop()!.resolve({ ...inquiry("A"), certFileBase64: null, productImages: [] }); await settle();
    typeAmount("200");
    assert.equal(textOf(quoteBtn()).trim(), "保存中…", "上一次还没回来，重新打开后按钮又能点了");
    assert.equal(quoteBtn().props.disabled, true);
    quoteBtn().props.onClick(); await settle();             // 就算点到了（按钮灰着点不到，这里硬点）
    assert.equal(quoteCalls().length, 1, "同一张单发出了第二次报价（晚到的旧价可能盖掉新价）");
    // 第一次回来之后才能再报
    quoteCalls()[0].resolve({}); await settle();
    detailCalls().filter((c) => !c.done).forEach((c) => { c.done = true; c.resolve({ ...inquiry("A"), certFileBase64: null, productImages: [] }); });
    await settle();
    typeAmount("200");
    assert.notEqual(textOf(quoteBtn()).trim(), "保存中…");
    quoteBtn().props.onClick(); await settle();
    assert.equal(quoteCalls().length, 2, "第一次回来以后还是报不了");
  });

  await check("U9 报价晚回来：刷新的是员工现在翻到的第 2 页，不拽回第 1 页；详情关了，成败也照样提示", async () => {
    await openPanelAndDetail();
    typeAmount("100");
    quoteBtn().props.onClick(); await settle();
    modal().props.onClose(); flush();
    btn("下一页")[0].props.onClick(); await settle();        // 翻到第 2 页
    const p2 = listCalls().pop()!;
    assert.ok(p2.url.includes("page=2"));
    p2.resolve({ items: [inquiry("B")], total: 120 }); await settle();
    const before = listCalls().length;
    quoteCalls()[0].resolve({}); await settle();            // 旧报价这时才回来
    const reload = listCalls().slice(before);
    assert.equal(reload.length, 1, "报价成功后没刷新列表");
    assert.ok(reload[0].url.includes("page=2"), `刷新的是 ${reload[0].url}（把员工拽回了第 1 页）`);
    assert.ok(toasts.some((t) => t.includes("已报价")), `详情关了，报价成功没提示：${JSON.stringify(toasts)}`);
    // 再来一次失败的：详情关着，失败要用提示条说出来
    btn("详情 / 报价")[0].props.onClick(); await settle();
    detailCalls().pop()!.resolve({ ...inquiry("B"), id: "B", certFileBase64: null, productImages: [] }); await settle();
    typeAmount("300");
    quoteBtn().props.onClick(); await settle();
    modal().props.onClose(); flush();
    quoteCalls().pop()!.reject(new Error("这张单刚被别人改过")); await settle();
    assert.ok(toasts.some((t) => t.includes("报价没保存") && t.includes("刚被别人改过")), `详情关了，报价失败一声不吭：${JSON.stringify(toasts)}`);
  });

  await check("U10 切到「整柜询价」就自己拉列表、切回来重拉、藏着不拉；加载失败点一下「重试」就真去拉", async () => {
    toasts.length = 0;
    const setVisible = (v: boolean) => { compProps = { ...compProps, visible: v }; rerender(); };
    const n0 = listCalls().length;
    mount(Panel, { visible: false, isStaff: true, onToast: (m: string) => toasts.push(m) });
    await settle();
    assert.equal(listCalls().length, n0, "这一栏还藏着就发了列表请求（整页一打开就白拉一次）");
    setVisible(true); await settle();
    assert.equal(listCalls().length, n0 + 1, "切到「整柜询价」没有自己拉列表，还得手点");
    assert.equal(btn("加载记录").length, 0, "还留着要手点的「加载记录」按钮");
    assert.ok(findAll((n) => n.type === "p" && textOf(n).includes("加载中")).length > 0, "拉的时候没写「加载中…」");
    listCalls().pop()!.reject(new Error("网断了")); await settle();
    assert.ok(toasts.some((t) => t.includes("加载询价记录失败")), `失败没提示：${JSON.stringify(toasts)}`);
    const retry = btn("加载失败，点击重试")[0];
    assert.ok(retry, "失败后没有重试按钮");
    retry.props.onClick(); await settle();
    assert.equal(listCalls().length, n0 + 2, "点了一次「重试」没真去拉（原来要再点一次「加载记录」）");
    listCalls().pop()!.resolve({ items: [inquiry("A")], total: 1 }); await settle();
    assert.equal(btn("详情 / 报价").length, 1, "重试成功后列表没出来");
    setVisible(false); await settle();
    assert.equal(listCalls().length, n0 + 2, "切走时不该再拉");
    setVisible(true); await settle();
    assert.equal(listCalls().length, n0 + 3, "切回来没重拉（客户新提交的询价要刷新整页才看得到）");
    assert.ok(listCalls().pop()!.url.includes("page=1"));
  });

  // ---------- 已读、时间、提示音（2026-10-02） ----------
  const sound = loadModule(path.join(SRC, "modules/cs-chat/chat-sound.ts"), OVERRIDES);
  const { useChatUnread } = loadModule(path.join(SRC, "modules/cs-chat/useChatUnread.ts"), OVERRIDES);
  let dings = 0;
  class FakeAudioContext {
    state = "running"; currentTime = 0; destination = {};
    createOscillator() { return { type: "", frequency: { setValueAtTime() {} }, connect() {}, start() { dings += 0.5; }, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    resume() { return Promise.resolve(); }
  }
  fakeWindow.AudioContext = FakeAudioContext;
  const realNow = Date.now;
  let clock = 1_000_000;
  /** 每次响完往后拨 2 秒（提示音 1 秒内只响一次，不拨的话第二声会被当成同一批吞掉） */
  const passTime = () => { clock += 2000; };
  Date.now = () => clock;
  const resetSound = () => { sound.resetChatSoundForTest(); dings = 0; passTime(); };
  /** 气泡旁边那一列的字（「已读」+ 时间）。「撤回」按钮另外测（U24），这里跳过它 */
  const textSkipping = (node: any, skipClass: string): string => {
    if (node == null || node === false || node === true) return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map((x) => textSkipping(x, skipClass)).join("");
    if (node.props?.className === skipClass) return "";
    return textSkipping(node.props?.children, skipClass);
  };
  const metas = () => findAll((n) => n.props?.className === "cs-msg-meta").map((n) => textSkipping(n, "cs-recall"));
  const dayRows = () => findAll((n) => n.type === "span" && /^(今天|昨天|\d+年?\d*月?\d+月\d+日 周.|\d+月\d+日 周.)$/.test(textOf(n))).map((n) => textOf(n));
  const pollCalls = () => calls.filter((c) => c.url.includes("/chat/messages") && c.url.includes("since=") && !c.done);
  async function answerPoll(body: any) {
    const c = pollCalls().pop();
    assert.ok(c, "没发轮询请求");
    c!.done = true;
    c!.resolve(body);
    await settle();
  }
  const cs = (id: string, t: string, mine = false) => ({ id, side: "cs", mine, senderLabel: mine ? "我" : "客服", content: id, imageUrl: null, createdAt: t });
  const cl = (id: string, t: string, mine = false) => ({ id, side: "client", mine, senderLabel: mine ? "我" : "ZZC1", content: id, imageUrl: null, createdAt: t });

  await check("U11 已读：我方发的、对方看过的写「已读」，对方的不写；对方一看，下一轮轮询就变；不会往回退", async () => {
    resetSound();
    // 客户那头：自己发的两条，客服看到了第一条那一刻
    mount(ChatThread, { scope: { kind: "client" }, title: "客服" });
    lastCall().resolve({
      messages: [cs("k1", "2026-09-28T00:59:00.000Z"), cl("m1", "2026-09-28T01:00:00.000Z", true), cl("m2", "2026-09-28T01:00:10.000Z", true)],
      hasMore: false, serverTime: "2026-09-28T01:00:20.000Z", peerReadAt: "2026-09-28T01:00:05.000Z",
    });
    await settle();
    assert.deepEqual(metas(), ["08:59", "已读09:00", "09:00"], `客服的不写、客服看过的写已读、没看的不写：${JSON.stringify(metas())}`);
    await tickTimers((t) => !t.once && t.ms === 3000);
    await answerPoll({ messages: [], hasMore: false, serverTime: "2026-09-28T01:00:23.000Z", peerReadAt: "2026-09-28T01:00:10.000Z" });
    assert.deepEqual(metas(), ["08:59", "已读09:00", "已读09:00"], "客服看过第二条了，下一轮没变已读");
    await tickTimers((t) => !t.once && t.ms === 3000);
    await answerPoll({ messages: [], hasMore: false, serverTime: "2026-09-28T01:00:26.000Z", peerReadAt: "2026-09-28T01:00:01.000Z" });
    assert.deepEqual(metas(), ["08:59", "已读09:00", "已读09:00"], "拿到一个更早的「看到哪」，已读被退回去了");
    unmount(); calls.length = 0; timers.length = 0;
    // 客服那头：别的员工发的（左边、不是我）也算我方；客户发的从来不写已读
    mount(ChatThread, { scope: { kind: "staff", clientId: "ZZC1" }, title: "ZZC1" });
    lastCall().resolve({
      messages: [cl("c1", "2026-09-28T01:00:00.000Z"), cs("s1", "2026-09-28T01:01:00.000Z", false), cs("s2", "2026-09-28T01:02:00.000Z", true)],
      hasMore: false, serverTime: "2026-09-28T01:02:05.000Z", peerReadAt: "2026-09-28T01:01:30.000Z",
    });
    await settle();
    assert.deepEqual(metas(), ["09:00", "已读09:01", "09:02"], `员工那头：${JSON.stringify(metas())}`);
  });

  await check("U12 每条都带时间（北京时间）；跨天插一行日期，UTC 16:30 算北京第二天 00:30", async () => {
    resetSound();
    mount(ChatThread, { scope: { kind: "client" }, title: "客服" });
    lastCall().resolve({
      messages: [cs("d1", "2026-09-27T03:00:00.000Z"), cl("d2", "2026-09-27T15:59:00.000Z", true), cs("d3", "2026-09-27T16:30:00.000Z")],
      hasMore: false, serverTime: "2026-09-27T16:31:00.000Z", peerReadAt: null,
    });
    await settle();
    assert.deepEqual(metas(), ["11:00", "23:59", "00:30"], `每条的时间不对：${JSON.stringify(metas())}`);
    const days = dayRows();
    assert.equal(days.length, 2, `应该两行日期（27 号、28 号），实际：${JSON.stringify(days)}`);
    assert.match(days[0], /9月27日 周日$/);
    assert.match(days[1], /9月28日 周一$/, "UTC 16:30 是北京第二天，日期行没跟着换");
    // 零点写法：有的浏览器 hour12:false 会把零点写成 24:05，Node 里测不出来，只能盯住写法（dsh 复查）
    const src = fs.readFileSync(path.join(SRC, "modules/cs-chat/ChatThread.tsx"), "utf8");
    assert.match(src, /hourCycle: "h23"/, "时间格式没写死 h23");
    assert.doesNotMatch(src, /hour12:\s*(true|false)\s*[,}]/, "又用回了 hour12（有的浏览器零点会写成 24:xx）");
    // 员工「客户消息」左边客户列表的时间也一样（dsh 第二轮复查）
    const listSrc = fs.readFileSync(path.join(SRC, "app/staff/chat/page.tsx"), "utf8");
    assert.doesNotMatch(listSrc, /hour12:\s*(true|false)\s*[,}]/, "员工客户列表的时间还用 hour12（零点会写成 24:xx）");
    assert.match(listSrc, /hourCycle: "h23"/);
  });

  await check("U13 提示音：打开时的旧消息不响；来了对方新消息响一次；同一条再带回来不响；自己发的、别的员工发的不响", async () => {
    resetSound();
    mount(ChatThread, { scope: { kind: "client" }, title: "客服" });
    lastCall().resolve({ messages: [cs("o1", "2026-09-28T01:00:00.000Z")], hasMore: false, serverTime: "2026-09-28T01:00:05.000Z", peerReadAt: null });
    await settle();
    assert.equal(dings, 0, "打开对话就响了（那是旧消息）");
    await tickTimers((t) => !t.once && t.ms === 3000);
    await answerPoll({ messages: [cs("o1", "2026-09-28T01:00:00.000Z"), cs("n1", "2026-09-28T01:00:07.000Z")], hasMore: false, serverTime: "2026-09-28T01:00:08.000Z", peerReadAt: null });
    assert.equal(dings, 1, `客服新发来一条，应该响一声，实际 ${dings}`);
    passTime();
    await tickTimers((t) => !t.once && t.ms === 3000);
    await answerPoll({ messages: [cs("n1", "2026-09-28T01:00:07.000Z"), cl("me1", "2026-09-28T01:00:09.000Z", true)], hasMore: false, serverTime: "2026-09-28T01:00:10.000Z", peerReadAt: null });
    assert.equal(dings, 1, "同一条又带回来、或者自己发的，又响了");
    unmount(); calls.length = 0; timers.length = 0;
    // 员工那头：别的员工回的（cs）不响，客户发的响
    resetSound();
    mount(ChatThread, { scope: { kind: "staff", clientId: "ZZC1" }, title: "ZZC1" });
    lastCall().resolve({ messages: [cl("c1", "2026-09-28T01:00:00.000Z")], hasMore: false, serverTime: "2026-09-28T01:00:05.000Z", peerReadAt: null });
    await settle();
    await tickTimers((t) => !t.once && t.ms === 3000);
    await answerPoll({ messages: [cs("other", "2026-09-28T01:00:06.000Z", false)], hasMore: false, serverTime: "2026-09-28T01:00:07.000Z", peerReadAt: null });
    assert.equal(dings, 0, "别的员工回了一句，员工这边也响了（只有客户发的才该响）");
    await tickTimers((t) => !t.once && t.ms === 3000);
    await answerPoll({ messages: [cl("c2", "2026-09-28T01:00:08.000Z")], hasMore: false, serverTime: "2026-09-28T01:00:09.000Z", peerReadAt: null });
    assert.equal(dings, 1, "客户发来新消息，员工这边没响");
  });

  await check("U14 菜单未读：第一次取回来不响；有更新的才响；聊天窗口为这条响过就不再响；网页切到后台也照样问", async () => {
    resetSound();
    function Probe(p: any) { const n = useChatUnread(p.session, false, p.path); return { type: "i", props: { children: String(n) } }; }
    const session = { userId: "zz_s1", companyId: "c_001", role: "staff", token: "x" };
    const unreadCalls = () => calls.filter((c) => c.url.includes("/chat/unread") && !c.done);
    async function answerUnread(body: any) {
      const c = unreadCalls().pop();
      assert.ok(c, "没去问未读");
      c!.done = true; c!.resolve(body); await settle();
    }
    mount(Probe, { session, path: "/staff" });
    await answerUnread({ count: 3, latestAt: "2026-09-28T01:00:00.000Z", latestByClient: { ZZC1: "2026-09-28T01:00:00.000Z" } });
    assert.equal(dings, 0, "一打开网页就响了（那几条是打开前就有的）");
    clock += 5000;
    await tickTimers((t) => !t.once && t.ms === 5000);
    await answerUnread({ count: 3, latestAt: "2026-09-28T01:00:00.000Z", latestByClient: { ZZC1: "2026-09-28T01:00:00.000Z" } });
    assert.equal(dings, 0, "没有新消息也响了");
    // 网页切到后台：照样问；来了新的照样响
    fakeDocument.visibilityState = "hidden";
    clock += 5000;
    await tickTimers((t) => !t.once && t.ms === 5000);
    assert.equal(unreadCalls().length, 0, "网页在后台还是 5 秒问一次（后台 15 秒一次就够，少打服务器）");
    clock += 10000;
    await tickTimers((t) => !t.once && t.ms === 5000);
    assert.equal(unreadCalls().length, 1, "网页切到后台就不问了（后台听不到提示音）");
    await answerUnread({ count: 4, latestAt: "2026-09-28T01:00:30.000Z", latestByClient: { ZZC1: "2026-09-28T01:00:30.000Z" } });
    assert.equal(dings, 1, "后台来了新消息没响");
    fakeDocument.visibilityState = "visible";
    passTime();
    unmount(); calls.length = 0; timers.length = 0;
    // 聊天窗口先为一条新消息响过，菜单随后取到同一条：不再响
    mount(ChatThread, { scope: { kind: "staff", clientId: "ZZC1" }, title: "ZZC1" });
    lastCall().resolve({ messages: [cl("c1", "2026-09-28T01:00:30.000Z")], hasMore: false, serverTime: "2026-09-28T01:00:35.000Z", peerReadAt: null });
    await settle();
    await tickTimers((t) => !t.once && t.ms === 3000);
    await answerPoll({ messages: [cl("c2", "2026-09-28T01:00:40.000Z")], hasMore: false, serverTime: "2026-09-28T01:00:41.000Z", peerReadAt: null });
    assert.equal(dings, 2, "聊天窗口没为新消息响");
    passTime();
    unmount(); calls.length = 0; timers.length = 0;
    mount(Probe, { session, path: "/staff/chat" });
    await answerUnread({ count: 1, latestAt: "2026-09-28T01:00:40.000Z", latestByClient: { ZZC1: "2026-09-28T01:00:40.000Z" } });
    assert.equal(dings, 2, "聊天窗口已经为这条响过，菜单又响了一次");
    passTime();
    unmount(); calls.length = 0; timers.length = 0;
    // 打开对话时已经看到的那条（菜单还没来得及问到）：菜单随后取到它也不响 —— 人已经在看了
    mount(ChatThread, { scope: { kind: "staff", clientId: "ZZC2" }, title: "ZZC2" });
    lastCall().resolve({ messages: [cl("x1", "2026-09-28T01:01:00.000Z")], hasMore: false, serverTime: "2026-09-28T01:01:05.000Z", peerReadAt: null });
    await settle();
    unmount(); calls.length = 0; timers.length = 0;
    mount(Probe, { session, path: "/staff/chat" });
    await answerUnread({ count: 1, latestAt: "2026-09-28T01:01:00.000Z", latestByClient: { ZZC2: "2026-09-28T01:01:00.000Z" } });
    assert.equal(dings, 2, "打开对话时已经看到的消息，菜单取到后又响了");
    passTime();
    unmount(); calls.length = 0; timers.length = 0;
    // 客户那头（dsh 第三轮：原来一条测试都没有）：菜单第一次不响、有新的响、聊天窗口已经为这条响过就不再响
    resetSound();
    const clientSession = { userId: "ZZC1", companyId: "c_001", role: "client", token: "x" };
    mount(Probe, { session: clientSession, path: "/client" });
    await answerUnread({ count: 1, latestAt: "2026-09-28T02:00:00.000Z" });
    assert.equal(dings, 0, "客户一打开网页就响了");
    clock += 5000;
    await tickTimers((t) => !t.once && t.ms === 5000);
    await answerUnread({ count: 2, latestAt: "2026-09-28T02:00:10.000Z" });
    assert.equal(dings, 1, "客户那头来了新消息，菜单没响");
    passTime();
    unmount(); calls.length = 0; timers.length = 0;
    mount(ChatThread, { scope: { kind: "client" }, title: "客服" });
    lastCall().resolve({ messages: [cs("k1", "2026-09-28T02:00:10.000Z")], hasMore: false, serverTime: "2026-09-28T02:00:15.000Z", peerReadAt: null });
    await settle();
    await tickTimers((t) => !t.once && t.ms === 3000);
    await answerPoll({ messages: [cs("k2", "2026-09-28T02:00:20.000Z")], hasMore: false, serverTime: "2026-09-28T02:00:21.000Z", peerReadAt: null });
    assert.equal(dings, 2, "客户聊天窗口来了新消息没响");
    passTime();
    unmount(); calls.length = 0; timers.length = 0;
    mount(Probe, { session: clientSession, path: "/client/chat" });
    await answerUnread({ count: 1, latestAt: "2026-09-28T02:00:20.000Z" });
    assert.equal(dings, 2, "客户聊天窗口已经为这条响过，客户菜单又响了（两边对话的叫法对不上）");
  });

  await check("U15 窗口不是当前窗口（人在别的软件里）：不标已读；点回这个窗口马上标", async () => {
    resetSound();
    let focused = false;
    fakeDocument.hasFocus = () => focused;
    try {
      mount(ChatThread, { scope: { kind: "staff", clientId: "ZZC1" }, title: "ZZC1" });
      lastCall().resolve({ messages: [cl("c1", "2026-09-28T01:00:00.000Z")], hasMore: false, serverTime: "2026-09-28T01:00:05.000Z", peerReadAt: null });
      await settle();
      const reads = () => calls.filter((c) => c.url.includes("/chat/read"));
      assert.equal(reads().length, 0, "浏览器窗口不在前面（人在别的软件里），客户的消息就被标了已读");
      await tickTimers((t) => !t.once && t.ms === 3000);
      assert.equal(reads().length, 0, "轮询时窗口还不在前面，又标了已读");
      focused = true;
      (listeners.focus ?? []).forEach((f) => f({ type: "focus" }));
      await settle();
      assert.equal(reads().length, 1, "点回这个窗口没有马上标已读");
      assert.match(reads()[0].opts.body, /"upTo":"2026-09-28T01:00:00.000Z"/);
    } finally {
      delete fakeDocument.hasFocus;
    }
  });

  await check("U16 1 秒内来了两条不同的新消息：第二声不丢，等满 1 秒补响", async () => {
    resetSound();
    mount(ChatThread, { scope: { kind: "client" }, title: "客服" });
    lastCall().resolve({ messages: [cs("o1", "2026-09-28T01:00:00.000Z")], hasMore: false, serverTime: "2026-09-28T01:00:05.000Z", peerReadAt: null });
    await settle();
    await tickTimers((t) => !t.once && t.ms === 3000);
    await answerPoll({ messages: [cs("n1", "2026-09-28T01:00:06.000Z")], hasMore: false, serverTime: "2026-09-28T01:00:07.000Z", peerReadAt: null });
    assert.equal(dings, 1);
    clock += 300; // 0.3 秒后菜单那边报到了另一条
    sound.noteUnreadLatest({ client: "2026-09-28T01:00:06.000Z" }); // 第一次：只记基线
    sound.noteUnreadLatest({ client: "2026-09-28T01:00:06.800Z" });
    assert.equal(dings, 1, "1 秒内不该马上响第二声");
    const pending = aliveTimers().filter((t) => t.once && t.ms > 0 && t.ms <= 1000);
    assert.equal(pending.length, 1, "第二声没有排着等补响（会被永远吞掉）");
    clock += 1000;
    await tickTimers((t) => t.once && t.ms > 0 && t.ms <= 1000);
    assert.equal(dings, 2, "等满 1 秒后没有补响第二声");
  });

  await check("U17 开着好几个标签页同一条只响一次；按对话记：客户甲刚响过，客户乙更早、没人看过的那条照样响", async () => {
    resetSound();
    const store = new Map<string, string>();
    fakeWindow.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
    const shared = () => JSON.parse(store.get("xt_chat_ding_v2") ?? "{}");
    try {
      sound.noteUnreadLatest({ ZZA: "2026-09-28T01:00:00.000Z" }); // 这个标签页的基线
      store.set("xt_chat_ding_v2", JSON.stringify({ ZZA: "2026-09-28T01:00:30.000Z" })); // 另一个标签页已经为客户甲 01:00:30 响过
      sound.noteUnreadLatest({ ZZA: "2026-09-28T01:00:30.000Z" });
      assert.equal(dings, 0, "另一个标签页已经响过这条，这边又响了一声");
      sound.noteUnreadLatest({ ZZA: "2026-09-28T01:00:40.000Z" });
      assert.equal(dings, 1, "更新的一条没有人响过，这边该响");
      assert.equal(shared().ZZA, "2026-09-28T01:00:40.000Z", "响完没记进共用记录，别的标签页还会再响");
      passTime();
      // dsh 第二轮：客户乙 01:00:05 那条没人看过 —— 不能因为客户甲已经报到 01:00:40 就不响
      sound.noteUnreadLatest({ ZZA: "2026-09-28T01:00:40.000Z", ZZB: "2026-09-28T01:00:05.000Z" });
      assert.equal(dings, 2, "客户乙那条更早、但没人看过，被客户甲的新消息压掉了，一声没响");
      passTime();
      // 同一个标签页里：聊天窗口刚为客户甲响过 01:01:10，菜单随后报出客户丙更早的 01:01:05 → 也要响
      sound.noteIncomingArrived("ZZA", "2026-09-28T01:01:10.000Z");
      assert.equal(dings, 3);
      passTime();
      sound.noteUnreadLatest({ ZZA: "2026-09-28T01:01:10.000Z", ZZB: "2026-09-28T01:00:05.000Z", ZZC: "2026-09-28T01:01:05.000Z" });
      assert.equal(dings, 4, "聊天窗口为客户甲响过，客户丙更早那条就不响了");
      passTime();
      // 另一个标签页打开客户丁的对话、看到了 01:02:00（那边只记不响）→ 这个标签页的菜单取到它不响；客户戊的照样响
      sound.noteIncomingShown("ZZD", "2026-09-28T01:02:00.000Z");
      assert.equal(shared().ZZD, "2026-09-28T01:02:00.000Z", "打开对话看到的那条没记进共用记录，别的标签页还会为它响");
      sound.resetChatSoundForTest(); // 模拟另一个标签页：自己的记录是空的，只有共用的那份
      sound.noteUnreadLatest({}); // 那个标签页的基线
      sound.noteUnreadLatest({ ZZD: "2026-09-28T01:02:00.000Z", ZZE: "2026-09-28T01:01:30.000Z" });
      assert.equal(dings, 5, "客户丁那条别的标签页已经看到了不该响，客户戊那条该响 —— 加起来应该正好一声");
      passTime();
      // 共用记录写满（1000 个对话、时间都比较新）：打开一个很久没聊的老客户，刚记进去的那条不能被自己裁掉（dsh 第三轮）
      const full: Record<string, string> = {};
      for (let i = 0; i < 1000; i++) full[`c:ZZFULL${i}`] = "2026-09-20T00:00:00.000Z";
      store.set("xt_chat_ding_v2", JSON.stringify(full));
      sound.noteIncomingShown("c:ZZOLD", "2026-09-01T01:00:00.000Z");
      assert.equal(shared()["c:ZZOLD"], "2026-09-01T01:00:00.000Z", "共用记录满了，刚记进去的老客户那条被自己裁掉了，别的标签页还会为它响");
      assert.ok(Object.keys(shared()).length <= 1000, "共用记录没有裁，越攒越大");
      sound.resetChatSoundForTest();
      sound.noteUnreadLatest({});
      sound.noteUnreadLatest({ "c:ZZOLD": "2026-09-01T01:00:00.000Z" });
      assert.equal(dings, 5, "那条老客户的消息在别的标签页已经显示了，这边又响");
      // 唛头叫 __proto__ / constructor（管理员自己填、不校验格式）：照样响
      sound.noteUnreadLatest({ [sound.chatSoundKey("__proto__")]: "2026-09-28T03:00:00.000Z" });
      assert.equal(dings, 6, "唛头叫 __proto__ 的客户来消息不响");
      passTime();
      sound.noteUnreadLatest({ [sound.chatSoundKey("constructor")]: "2026-09-28T03:00:10.000Z" });
      assert.equal(dings, 7, "唛头叫 constructor 的客户来消息不响");
      assert.notEqual(sound.chatSoundKey("client"), sound.chatSoundKey(), "唛头叫 client 的客户，跟客户那头自己的对话撞成一个叫法");
    } finally {
      delete fakeWindow.localStorage;
    }
  });

  await check("U18 页面开着过了零点：日期行自己从「今天」变「昨天」，不用等新消息", async () => {
    resetSound();
    const RealDate = Date;
    let fakeMs = RealDate.parse("2026-10-01T15:59:00.000Z"); // 北京 10-01 23:59
    class FakeDate extends RealDate {
      constructor(...args: any[]) { if (args.length === 0) super(fakeMs); else super(...(args as [any])); }
      static now() { return clock; }
    }
    (globalThis as any).Date = FakeDate;
    try {
      mount(ChatThread, { scope: { kind: "client" }, title: "客服" });
      lastCall().resolve({ messages: [cs("z1", "2026-10-01T15:00:00.000Z")], hasMore: false, serverTime: "2026-10-01T15:59:00.000Z", peerReadAt: null });
      await settle();
      assert.deepEqual(dayRows(), ["今天"]);
      fakeMs = RealDate.parse("2026-10-01T16:01:00.000Z"); // 北京 10-02 00:01
      await tickTimers((t) => !t.once && t.ms === 60_000);
      assert.deepEqual(dayRows(), ["昨天"], "过了零点没有消息进来，昨天的消息还写着「今天」");
    } finally {
      (globalThis as any).Date = RealDate;
      Date.now = () => clock;
    }
  });

  await check("U19 换对话那一瞬间窗口获得焦点：不会拿上一个客户的消息时间去标下一个客户的已读", async () => {
    resetSound();
    fakeDocument.hasFocus = () => true;
    try {
      mount(ChatThread, { scope: { kind: "staff", clientId: "ZZCA" }, title: "ZZCA" });
      lastCall().resolve({ messages: [cl("a1", "2026-09-28T01:00:00.000Z")], hasMore: false, serverTime: "2026-09-28T01:00:05.000Z", peerReadAt: null });
      await settle();
      // 客户甲那次标已读还没回来（网慢）：lastMarked 还是空的
      const readsOf = (cid: string) => calls.filter((c) => c.url.includes("/chat/read") && String(c.opts.body).includes(`"clientId":"${cid}"`));
      assert.equal(readsOf("ZZCA").length, 1, "前提不成立：打开客户甲应该标一次已读");
      // 点了客户乙：按新客户画了一帧，清空旧消息的 effect 还没跑 —— 这时窗口获得焦点
      holdEffects = true;
      compProps = { scope: { kind: "staff", clientId: "ZZCB" }, title: "ZZCB" };
      rerender();
      (listeners.focus ?? []).forEach((f) => f({ type: "focus" }));
      assert.equal(readsOf("ZZCB").length, 0, `拿客户甲的消息时间去标了客户乙的已读：${readsOf("ZZCB").map((c) => c.opts.body).join(" ")}`);
      runHeldEffects();
      await settle();
      // 客户乙自己的消息取回来以后，照常标乙的已读
      const loadB = calls.filter((c) => c.url.includes("/staff/chat/messages") && c.url.includes("clientId=ZZCB") && !c.done).pop();
      assert.ok(loadB, "没去取客户乙的消息");
      loadB!.done = true;
      loadB!.resolve({ messages: [cl("b1", "2026-09-28T01:05:00.000Z")], hasMore: false, serverTime: "2026-09-28T01:05:05.000Z", peerReadAt: null });
      await settle();
      assert.equal(readsOf("ZZCB").length, 1, "客户乙的消息取回来后没有标乙的已读");
      assert.match(String(readsOf("ZZCB")[0].opts.body), /"upTo":"2026-09-28T01:05:00.000Z"/, "标客户乙已读用的不是乙自己的消息时间");
    } finally {
      if (holdEffects) runHeldEffects();
      delete fakeDocument.hasFocus;
    }
  });

  await check("U20 员工聊天页的客户列表不报提示音（不跟菜单抢基线）：列表先刷到新消息，菜单随后照样响", async () => {
    resetSound();
    fakeWindow.location.search = "";
    const item = (clientId: string, at: string, fromClient = true, unread = 1) => ({ clientId, lastMessageAt: at, lastMessagePreview: "hi", lastFromClient: fromClient, unreadCount: unread, closed: false });
    sound.noteUnreadLatest({}); // 左边菜单先取过一次（当时还没有未读）
    mount(Inbox, {});
    await answerList([item("ZZA", "2026-09-28T04:00:00.000Z"), item("ZZB", "2026-09-28T04:00:05.000Z")]);
    await tickTimers((t) => !t.once && t.ms === 5000);
    await answerList([item("ZZA", "2026-09-28T04:00:00.000Z"), item("ZZB", "2026-09-28T04:00:30.000Z")]);
    assert.equal(dings, 0, "客户列表也在报提示音（会跟菜单抢基线）");
    // 菜单随后取到：照样响（原来列表第一次取回来时把它悄悄记成「报过了」，菜单就不响了）
    sound.noteUnreadLatest({ [sound.chatSoundKey("ZZA")]: "2026-09-28T04:00:00.000Z", [sound.chatSoundKey("ZZB")]: "2026-09-28T04:00:30.000Z" });
    assert.equal(dings, 1, "列表先刷到了新消息，菜单随后取到却不响");
  });

  await check("U21 菜单未读在眼前 5 秒问一次；计时放在 Worker 里（后台不被浏览器放慢）；Worker 起不来退回页面定时器；关页面关 Worker", async () => {
    resetSound();
    const workers: any[] = [];
    class FakeWorker {
      url: string; posted: any[] = []; terminated = false; onmessage: any = null; onerror: any = null;
      constructor(url: string) { this.url = url; workers.push(this); }
      postMessage(v: any) { this.posted.push(v); }
      terminate() { this.terminated = true; }
    }
    (globalThis as any).Worker = FakeWorker;
    try {
      function Probe2(p: any) { const n = useChatUnread(p.session, false, p.path); return { type: "i", props: { children: String(n) } }; }
      const session = { userId: "zz_s1", companyId: "c_001", role: "staff", token: "x" };
      const unreadCalls = () => calls.filter((c) => c.url.includes("/chat/unread"));
      mount(Probe2, { session, path: "/staff" });
      assert.equal(workers.length, 1, "没有起 Worker 计时器");
      assert.equal(workers[0].url, "/chat-tick.worker.js");
      assert.deepEqual(workers[0].posted, [5000], "Worker 的间隔不是 5 秒（在别的页面来消息要等太久）");
      assert.equal(aliveTimers().filter((t) => !t.once && t.ms === 5000).length, 0, "有了 Worker 还另开了页面定时器（会问两遍）");
      // 第一次问未读先回掉（上一次没回来不会发新的）
      unreadCalls()[0].resolve({ count: 0, latestAt: null, latestByClient: {} });
      await settle();
      const n0 = unreadCalls().length;
      clock += 5000;
      workers[0].onmessage({ data: 1 });
      assert.equal(unreadCalls().length, n0 + 1, "Worker 到点了没去问未读");
      // Worker 起不来（文件没取到）：退回页面自己的定时器
      workers[0].onerror({});
      assert.equal(workers[0].terminated, true);
      assert.equal(aliveTimers().filter((t) => !t.once && t.ms === 5000).length, 1, "Worker 坏了没有退回页面定时器，以后再也不问了");
      unmount();
      // 关页面（退出登录、换角色）：Worker 要关掉，不然后台一直在问
      timers.length = 0; calls.length = 0;
      mount(Probe2, { session, path: "/staff" });
      const w = workers[workers.length - 1];
      unmount();
      assert.equal(w.terminated, true, "页面关了 Worker 还开着，后台一直在问");
      // 真把 public/chat-tick.worker.js 跑一遍：收到间隔后按间隔给页面发「到点了」；换间隔会先停掉旧的
      const code = fs.readFileSync(path.join(process.cwd(), "apps/web/public/chat-tick.worker.js"), "utf8");
      const intervals: Array<{ fn: () => void; ms: number; alive: boolean }> = [];
      const self: any = { posted: 0, postMessage() { self.posted += 1; } };
      new Function("self", "setInterval", "clearInterval", code)(
        self,
        (fn: () => void, ms: number) => { intervals.push({ fn, ms, alive: true }); return intervals.length; },
        (id: number) => { if (intervals[id - 1]) intervals[id - 1].alive = false; },
      );
      assert.equal(typeof self.onmessage, "function", "Worker 文件没有接页面发来的间隔（文件是空的？）");
      self.onmessage({ data: 5000 });
      assert.deepEqual(intervals.map((t) => t.ms), [5000], "Worker 没按页面给的 5 秒计时");
      intervals[0].fn();
      assert.equal(self.posted, 1, "Worker 到点了没告诉页面");
      self.onmessage({ data: 15000 });
      assert.equal(intervals[0].alive, false, "换间隔没停掉旧的计时器（会叫两遍）");
      assert.equal(intervals[1].ms, 15000);
    } finally {
      delete (globalThis as any).Worker;
    }
  });

  await check("U22 服务器慢（一次超过 5 秒）：上一次没回来不发新的、回来了不作废；中途要求刷新的回来后补问一次", async () => {
    resetSound();
    function Probe3(p: any) { const n = useChatUnread(p.session, false, p.path); return { type: "i", props: { children: String(n) } }; }
    const session = { userId: "zz_s1", companyId: "c_001", role: "staff", token: "x" };
    const unreadCalls = () => calls.filter((c) => c.url.includes("/chat/unread"));
    mount(Probe3, { session, path: "/staff" });
    assert.equal(unreadCalls().length, 1);
    // 第一次 6 秒还没回来：到点了也不发第二个
    clock += 5000;
    await tickTimers((t) => !t.once && t.ms === 5000);
    assert.equal(unreadCalls().length, 1, "上一次还没回来又发了一个（越堆越多，前一个的结果会被作废）");
    // 中途聊天窗口发了消息，要求马上刷新：也先记着
    fakeWindow.dispatchEvent({ type: "xt-chat-unread-changed" });
    assert.equal(unreadCalls().length, 1);
    // 第一次回来了：结果要用上（红点变 3），并且立刻补问一次。
    // 客户乙 05:00:04 那条是第一次问的那几秒里刚到的（服务器回结果时 05:00:06）—— 要响；客户甲 04:50:00 那条是打开网页前就有的 —— 不响
    unreadCalls()[0].resolve({
      count: 3, latestAt: "2026-09-28T05:00:04.000Z", serverTime: "2026-09-28T05:00:06.000Z",
      latestByClient: { ZZA: "2026-09-28T04:50:00.000Z", ZZB: "2026-09-28T05:00:04.000Z" },
    });
    await settle();
    assert.equal(textOf(tree), "3", "慢回来的结果被作废了，红点没变");
    assert.equal(dings, 1, "第一次问未读很慢、这期间对方发来的消息，跟着第一次结果回来却不响（Codex 第二轮）");
    assert.equal(unreadCalls().length, 2, "中途要求刷新的，回来后没有补问");
    passTime();
    unreadCalls()[1].resolve({
      count: 3, latestAt: "2026-09-28T05:00:04.000Z", serverTime: "2026-09-28T05:00:11.000Z",
      latestByClient: { ZZA: "2026-09-28T04:50:00.000Z", ZZB: "2026-09-28T05:00:04.000Z" },
    });
    await settle();
    assert.equal(dings, 1, "补问回来的是同一条，又响了一次");
  });

  await check("U23 员工菜单只报最近 50 个：打开网页前就有、后来才排进 50 个的旧未读不响；退出 / 换人登录时清掉提示音记录", async () => {
    resetSound();
    // 打开网页时：50 个未读客户，最新的一条是 06:00:50（第 51 个更早、没报上来）
    const first: Record<string, string> = {};
    for (let i = 0; i < 50; i++) first[sound.chatSoundKey(`ZZK${i}`)] = `2026-09-28T06:00:${String(i + 1).padStart(2, "0")}.000Z`;
    sound.noteUnreadLatest(first, "2026-09-28T06:05:00.000Z"); // 服务器回结果时 06:05:00，这 50 条都是 10 秒以前的
    assert.equal(dings, 0, "打开网页时就有的 50 条（都是 10 秒以前到的）响了");
    // 有人看了一个，第 51 个（06:00:00 那条，打开网页前就有）挤进来：不响
    sound.noteUnreadLatest({ [sound.chatSoundKey("ZZOLD51")]: "2026-09-28T06:00:00.000Z" });
    assert.equal(dings, 0, "打开网页前就有的旧未读，后来排进最近 50 个时响了");
    // 真新来的照样响
    sound.noteUnreadLatest({ [sound.chatSoundKey("ZZNEW")]: "2026-09-28T06:06:00.000Z" });
    assert.equal(dings, 1, "打开网页后真新来的消息没响");
    // 退出 / 换人登录：提示音记录（里面是客户唛头和时间）跟运单缓存一起清
    const store = new Map<string, string>([["xt_chat_ding_v2", "{\"c:ZZA\":\"x\"}"], ["xt_chat_ding_upto_v1", "x"], ["xt_orders_ZZA", "[]"], ["auth_session_v1", "{}"]]);
    fakeWindow.localStorage = {
      get length() { return store.size; },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
    try {
      const authMod = loadModule(path.join(SRC, "auth/auth-session.ts"), OVERRIDES);
      authMod.clearClientOrderCaches();
      assert.ok(!store.has("xt_chat_ding_v2") && !store.has("xt_chat_ding_upto_v1"), `退出后提示音记录还在（公用电脑上下一个人看得到上一个人的客户）：${[...store.keys()]}`);
      assert.ok(!store.has("xt_orders_ZZA"), "运单缓存没清");
      assert.ok(store.has("auth_session_v1"), "清缓存把登录状态也清了（这个函数不管登录状态）");
    } finally {
      delete fakeWindow.localStorage;
    }
  });

  // ---------- 2026-10-02：撤回 / 选运单 / 待回复 / 系统通知 ----------
  const recalledRows = () => findAll((n) => n.props?.className === "cs-recalled").map(textOf);
  const recallBtns = () => findAll((n) => n.props?.className === "cs-recall");
  const bodyText = () => textOf(findAll((n) => n.props?.["aria-live"] === "polite")[0]);

  await check("U24 撤回：自己的、按服务器的钟 2 分钟内才有「撤回」，过了自己消失；点了发撤回、这一条变「你撤回了一条消息」", async () => {
    resetSound();
    mount(ChatThread, { scope: { kind: "client" }, title: "客服" });
    // 服务器 01:02:00。本机钟（假的，1970 年）跟服务器差几十年 —— 按钮还对，说明是按服务器的钟算的
    lastCall().resolve({
      messages: [cs("k1", "2026-09-28T01:01:00.000Z"), cl("old", "2026-09-28T00:59:59.000Z", true), cl("new", "2026-09-28T01:01:30.000Z", true)],
      hasMore: false, serverTime: "2026-09-28T01:02:00.000Z", peerReadAt: null,
    });
    await settle();
    assert.equal(recallBtns().length, 1, `只有自己 2 分钟内发的那条该有「撤回」，实际 ${recallBtns().length} 个`);
    // 过了 1 分钟（服务器的钟跟着走）：new 也超过 2 分钟了，按钮自己消失（有能撤回的消息时 10 秒重画一次）
    clock += 95_000; // 服务器的钟走到 01:03:35，new（01:01:30）发出超过 2 分钟了
    await tickTimers((t) => !t.once && t.ms === 10_000);
    assert.equal(recallBtns().length, 0, "过了 2 分钟「撤回」还在");
    unmount(); calls.length = 0; timers.length = 0;
    // 再来：点「撤回」
    mount(ChatThread, { scope: { kind: "client" }, title: "客服" });
    lastCall().resolve({ messages: [cl("m9", "2026-09-28T01:01:30.000Z", true)], hasMore: false, serverTime: "2026-09-28T01:02:00.000Z", peerReadAt: null });
    await settle();
    recallBtns()[0].props.onClick(); await settle();
    assert.equal(textOf(recallBtns()[0]), "撤回中");
    const rc = calls.filter((c) => c.url.includes("/client/chat/recall")).pop();
    assert.ok(rc, "点了「撤回」没发请求");
    assert.deepEqual(JSON.parse(rc!.opts.body), { messageId: "m9" });
    rc!.resolve({ message: { ...cl("m9", "2026-09-28T01:01:30.000Z", true), content: null, recalled: true, ref: null } });
    await settle();
    assert.deepEqual(recalledRows(), ["你撤回了一条消息"]);
    assert.ok(!bodyText().includes("m9"), "撤回以后原文还显示着");
    // 员工那头撤自己的：请求带上唛头
    unmount(); calls.length = 0; timers.length = 0;
    mount(ChatThread, { scope: { kind: "staff", clientId: "ZZC1" }, title: "ZZC1" });
    lastCall().resolve({ messages: [cs("s9", "2026-09-28T01:01:30.000Z", true), cs("other", "2026-09-28T01:01:40.000Z", false)], hasMore: false, serverTime: "2026-09-28T01:02:00.000Z", peerReadAt: null });
    await settle();
    assert.equal(recallBtns().length, 1, "别的员工发的也出了「撤回」");
    recallBtns()[0].props.onClick(); await settle();
    const sc = calls.filter((c) => c.url.includes("/staff/chat/recall")).pop();
    assert.deepEqual(JSON.parse(sc!.opts.body), { clientId: "ZZC1", messageId: "s9" });
    sc!.reject(new Error("发出超过 2 分钟了，不能撤回")); await settle();
    assert.ok(findAll((n) => n.props?.role === "alert").map(textOf).some((t) => t.includes("没撤回成")), "撤回失败没提示");
  });

  await check("U25 对方撤回：轮询带回同一条（已撤回），这边换成「客服 撤回了一条消息」；发了马上就撤回的不响", async () => {
    resetSound();
    mount(ChatThread, { scope: { kind: "client" }, title: "客服" });
    lastCall().resolve({ messages: [cs("p1", "2026-09-28T01:00:00.000Z")], hasMore: false, serverTime: "2026-09-28T01:00:05.000Z", peerReadAt: null });
    await settle();
    assert.ok(bodyText().includes("p1"));
    await tickTimers((t) => !t.once && t.ms === 3000);
    await answerPoll({ messages: [{ ...cs("p1", "2026-09-28T01:00:00.000Z"), content: null, recalled: true, ref: null }], hasMore: false, serverTime: "2026-09-28T01:00:08.000Z", peerReadAt: null });
    assert.deepEqual(recalledRows(), ["客服 撤回了一条消息"], `对方撤回了，这边没变：${JSON.stringify(recalledRows())}`);
    assert.ok(!bodyText().includes("p1"), "对方撤回了，原文还显示着");
    // 两轮轮询之间发了又撤回的：第一次见到就是已撤回的，不响
    passTime();
    await tickTimers((t) => !t.once && t.ms === 3000);
    await answerPoll({ messages: [{ ...cs("p2", "2026-09-28T01:00:09.000Z"), content: null, recalled: true, ref: null }], hasMore: false, serverTime: "2026-09-28T01:00:11.000Z", peerReadAt: null });
    assert.equal(dings, 0, "对方发了马上撤回的，也响了");
  });

  const refList = {
    shipments: [{ id: "s1", no: "XT001", title: "蓝牙耳机", status: "delivered", packageCount: 3, packageUnit: "箱" }],
    fcl: [{ id: "f1", no: "BL01", title: "鞋子", status: "departed", packageCount: 10, packageUnit: "箱" }],
    shipmentsTruncated: false, fclTruncated: true,
  };
  const refCalls = () => calls.filter((c) => c.url.includes("/chat/refs") && !c.done);
  const sendBtn = () => findAll((n) => n.type === "button" && /^(发送|发送中)$/.test(textOf(n)))[0];

  const RefPicker = loadModule(path.join(SRC, "modules/cs-chat/ChatRefPicker.tsx"), OVERRIDES).default;
  const pickerNode = () => findAll((n) => n.type === RefPicker)[0];
  const chipText = () => findAll((n) => n.props?.className === "cs-ref-chip").map(textOf)[0];

  await check("U26 选运单：聊天窗口点「选运单」出选单框，选了出「关于：…」；只发单子不打字也能发；发出去才去掉，没发出去留着", async () => {
    resetSound();
    await boot();
    assert.equal(sendBtn().props.disabled, true, "什么都没有，发送按钮却能点");
    findAll((n) => n.type === "button" && textOf(n) === "选运单")[0].props.onClick(); flush();
    assert.ok(pickerNode(), "点「选运单」没出选单框");
    assert.deepEqual(pickerNode().props.scope, { kind: "client" });
    pickerNode().props.onPick({ type: "fcl", id: "f1", no: "BL01", title: "鞋子" }); flush();
    assert.equal(pickerNode(), undefined, "选好了框没收起来");
    assert.ok(chipText()?.includes("关于：整柜 BL01（鞋子）"), `输入框上方没出「关于：…」：${chipText()}`);
    // 不打字直接发：只带单子
    assert.equal(sendBtn().props.disabled, false, "选了单子没打字，发送按钮是灰的");
    sendBtn().props.onClick(); flush();
    const s1 = sendCalls().pop()!;
    assert.deepEqual(JSON.parse(s1.opts.body), { ref: { type: "fcl", id: "f1" } });
    assert.ok(chipText(), "还没发出去就把「关于：…」去掉了");
    s1.resolve({ message: { ...msg("r1", true, "2026-09-28T01:00:06.000Z"), content: null, recalled: false, ref: { type: "fcl", id: "f1", no: "BL01", title: "鞋子", status: "departed", gone: false } } });
    await settle();
    assert.equal(chipText(), undefined, "发出去了「关于：…」还在");
    // 打字 + 单子一起发；没发出去：单子留着、原话放回来
    findAll((n) => n.type === "button" && textOf(n) === "选运单")[0].props.onClick(); flush();
    pickerNode().props.onPick({ type: "shipment", id: "s1", no: "XT001", title: "蓝牙耳机" }); flush();
    ta().props.onChange({ target: { value: "这票签收了吗" } }); flush();
    enter(); flush();
    const s2 = sendCalls().pop()!;
    assert.deepEqual(JSON.parse(s2.opts.body), { content: "这票签收了吗", ref: { type: "shipment", id: "s1" } });
    s2.reject(new Error("网络断了")); await settle();
    assert.ok(chipText(), "没发出去，选好的单子丢了");
    assert.equal(ta().props.value, "这票签收了吗");
    // 「×」不带这张单
    findAll((n) => n.type === "button" && n.props["aria-label"] === "不带这张单")[0].props.onClick(); flush();
    assert.equal(chipText(), undefined);
  });

  await check("U26b 选单框（ChatRefPicker 真跑）：列客户自己的运单 / 整柜、状态用客户的叫法、到顶了写出来；搜索停手 300 毫秒交给后端；客服那头带上唛头", async () => {
    const picked: any[] = [];
    mount(RefPicker, { scope: { kind: "client" }, onPick: (r: any) => picked.push(r), onClose() {} });
    await tickTimers((t) => t.once && t.ms === 0);
    const c1 = refCalls().pop();
    assert.equal(c1?.url, "/client/chat/refs", `打开没去取单子，或者地址不对：${c1?.url}`);
    c1!.done = true; c1!.resolve(refList); await settle();
    const pt = textOf(tree);
    assert.ok(pt.includes("XT001") && pt.includes("已签收"), `运单那栏不对（客户看 delivered 应叫「已签收」）：${pt}`);
    assert.ok(pt.includes("BL01") && pt.includes("只列了最近"), "整柜到顶了没写出来");
    findAll((n) => n.type === "input" && n.props["aria-label"] === "搜运单")[0].props.onChange({ target: { value: "BL" } }); flush();
    assert.equal(refCalls().length, 0, "一打字就去问了（没等停手）");
    await tickTimers((t) => t.once && t.ms === 300);
    const c2 = refCalls().pop();
    assert.equal(c2?.url, "/client/chat/refs?q=BL", "搜索没交给后端");
    c2!.done = true; c2!.resolve({ ...refList, shipments: [] }); await settle();
    findAll((n) => n.type === "button" && n.key === "fcl:f1")[0].props.onClick();
    assert.deepEqual(picked, [{ type: "fcl", id: "f1", no: "BL01", title: "鞋子" }]);
    unmount(); calls.length = 0; timers.length = 0;
    mount(RefPicker, { scope: { kind: "staff", clientId: "ZZ C1" }, onPick() {}, onClose() {} });
    await tickTimers((t) => t.once && t.ms === 0);
    assert.equal(refCalls().pop()?.url, "/staff/chat/refs?clientId=ZZ+C1", "客服那头取单子没带唛头");
  });

  await check("U27 气泡里的单子卡片：单号、品名、现在的状态（客户看 delivered 叫「已签收」，员工叫「派送完成」）；删了的写清楚", async () => {
    resetSound();
    const withRef = (id: string, ref: any, mine = false) => ({ ...cs(id, "2026-09-28T01:00:00.000Z", mine), content: null, recalled: false, ref });
    mount(ChatThread, { scope: { kind: "client" }, title: "客服" });
    lastCall().resolve({
      messages: [withRef("a", { type: "shipment", id: "s1", no: "XT001", title: "蓝牙耳机", status: "delivered", gone: false }), withRef("b", { type: "fcl", id: "f1", no: "BL01", title: null, status: null, gone: true })],
      hasMore: false, serverTime: "2026-09-28T01:00:05.000Z", peerReadAt: null,
    });
    await settle();
    let cards = findAll((n) => n.props?.className === "cs-ref-card").map(textOf);
    assert.equal(cards.length, 2);
    assert.ok(cards[0].includes("运单") && cards[0].includes("XT001") && cards[0].includes("蓝牙耳机") && cards[0].includes("现在：已签收"), `卡片不对：${cards[0]}`);
    assert.ok(cards[1].includes("整柜") && cards[1].includes("BL01") && cards[1].includes("已删除"), `删了的单没写清楚：${cards[1]}`);
    unmount(); calls.length = 0; timers.length = 0;
    mount(ChatThread, { scope: { kind: "staff", clientId: "ZZC1" }, title: "ZZC1" });
    lastCall().resolve({ messages: [withRef("a", { type: "shipment", id: "s1", no: "XT001", title: "蓝牙耳机", status: "delivered", gone: false })], hasMore: false, serverTime: "2026-09-28T01:00:05.000Z", peerReadAt: null });
    await settle();
    cards = findAll((n) => n.props?.className === "cs-ref-card").map(textOf);
    assert.ok(cards[0].includes("现在：派送完成"), `员工那头的叫法不对：${cards[0]}`);
    // 轮询带回同一条、状态变了：卡片跟着变
    await tickTimers((t) => !t.once && t.ms === 3000);
    await answerPoll({ messages: [withRef("a", { type: "shipment", id: "s1", no: "XT001", title: "蓝牙耳机", status: "returned", gone: false })], hasMore: false, serverTime: "2026-09-28T01:00:08.000Z", peerReadAt: null });
    cards = findAll((n) => n.props?.className === "cs-ref-card").map(textOf);
    assert.ok(cards[0].includes("现在：已退回"), `状态变了卡片没跟着变：${cards[0]}`);
  });

  await check("U28 员工「客户消息」：「全部 / 待回复」页签（带上 filter=pending）、待回复写等了多久、摘要「我方：」按最新一条还在的算", async () => {
    fakeWindow.location.search = "";
    mount(Inbox, {});
    const row = (clientId: string, over: any) => ({ clientId, lastMessageAt: "2026-09-28T01:00:00.000Z", lastMessagePreview: "hi", lastFromClient: false, lastFromUs: false, unreadCount: 0, closed: false, pendingReply: false, pendingSince: null, ...over });
    const answer = async (items: any[], pendingCount: number) => {
      for (const c of calls.filter((x) => x.url.includes("/staff/chat/conversations") && !x.done)) { c.done = true; c.resolve({ items, truncated: false, pendingCount }); }
      await settle();
    };
    await answer([
      row("WAIT1", { pendingReply: true, pendingSince: new Date(clock - 5 * 60_000).toISOString(), lastFromClient: true, lastMessagePreview: "货到了吗" }),
      row("DONE2", { lastFromUs: true, lastMessagePreview: "已经到了" }),
      row("GONE3", { lastFromUs: false, lastFromClient: false, lastMessagePreview: "[撤回了一条消息]" }),
    ], 1);
    const tabs = findAll((n) => n.props?.role === "tab");
    assert.deepEqual(tabs.map(textOf), ["全部", "待回复 1"]);
    const tags = findAll((n) => n.props?.className === "cs-pending-tag").map(textOf);
    assert.deepEqual(tags, ["待回复 · 等了 5 分钟"], `待回复的标签不对：${JSON.stringify(tags)}`);
    const rowText = (id: string) => textOf(findAll((n) => n.type === "button" && n.key === id)[0]);
    assert.ok(rowText("DONE2").includes("我方：已经到了"));
    assert.ok(!rowText("GONE3").includes("我方："), "一条都不剩（全撤回了）的对话，摘要前面写了「我方」");
    tabs[1].props.onClick(); flush(); await settle();
    const last = calls.filter((x) => x.url.includes("/staff/chat/conversations")).pop();
    assert.ok(last && new URL(last.url, "http://x").searchParams.get("filter") === "pending", `点「待回复」没按待回复去取：${last?.url}`);
    await answer([], 0);
    const empty = textOf(findAll((n) => n.type === "aside")[0]);
    assert.ok(empty.includes("没有待回复的对话"), "待回复为空时没说清楚");
  });

  await check("U29 浏览器系统通知（chat-push.ts 真跑）：开 → 交给后端、记下是谁开的；换人登录 → 退掉；退出先在浏览器退掉再告诉后端；没配 / 被禁止 / 不支持", async () => {
    const push = loadModule(path.join(SRC, "modules/cs-chat/chat-push.ts"), OVERRIDES);
    const store = new Map<string, string>();
    fakeWindow.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
    const keyB64 = Buffer.alloc(65, 7).toString("base64url");
    const unsubscribed: string[] = [];
    let current: any = null;
    let registered = false;
    let subscribeOpts: any = null;
    const mkSub = (endpoint: string) => ({
      endpoint,
      options: { applicationServerKey: new Uint8Array(Buffer.alloc(65, 7)).buffer },
      toJSON: () => ({ endpoint, keys: { p256dh: "P".repeat(87), auth: "A".repeat(22) } }),
      unsubscribe: async () => { unsubscribed.push(endpoint); current = null; return true; },
    });
    const reg = { pushManager: { getSubscription: async () => current, subscribe: async (o: any) => { subscribeOpts = o; current = mkSub("https://fcm.googleapis.com/fcm/send/NEW"); return current; } } };
    const fakeNavigator = { userAgent: "Mozilla/5.0 Chrome/140", platform: "Win32", maxTouchPoints: 0, serviceWorker: { getRegistration: async () => (registered ? reg : undefined), register: async (p: string, o: any) => { assert.equal(p, "/push-sw.js"); assert.deepEqual(o, { scope: "/" }); registered = true; return reg; }, ready: Promise.resolve(reg) } };
    const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: fakeNavigator, configurable: true, writable: true });
    const notif: any = { permission: "default", requestPermission: async () => { notif.permission = "granted"; return "granted"; } };
    fakeWindow.Notification = notif; (globalThis as any).Notification = notif;
    fakeWindow.PushManager = function PushManager() {};
    const me = { role: "staff", userId: "zz_s1", companyId: "c_001", token: "t1" };
    const other = { role: "staff", userId: "zz_s2", companyId: "c_001", token: "t2" };
    const pushCalls = (part: string) => calls.filter((c) => c.url.includes(`/staff/chat/push/${part}`) && !c.done);
    /** 一路把后端请求按顺序放行，直到这个异步调用跑完 */
    async function drive<T>(p: Promise<T>, answers: Record<string, any>): Promise<T> {
      let done = false; let out: any; let err: any;
      p.then((v) => { done = true; out = v; }, (e) => { done = true; err = e; });
      for (let i = 0; i < 30 && !done; i++) {
        await settle();
        for (const [part, ans] of Object.entries(answers)) for (const c of pushCalls(part)) { c.done = true; c.resolve(ans); }
      }
      if (err) throw err;
      assert.ok(done, "异步调用没跑完（卡在某个请求上）");
      return out;
    }
    try {
      assert.equal(await drive(push.readChatPushState(me), { key: { enabled: true, publicKey: keyB64 } }), "off");
      assert.equal(await drive(push.enableChatPush(me), { key: { enabled: true, publicKey: keyB64 }, subscribe: { ok: true } }), "on");
      assert.equal(subscribeOpts.userVisibleOnly, true);
      assert.deepEqual([...subscribeOpts.applicationServerKey], [...Buffer.alloc(65, 7)], "订阅用的公钥不是服务器给的那把");
      const sub1 = calls.filter((c) => c.url.includes("/staff/chat/push/subscribe")).pop()!;
      assert.deepEqual(JSON.parse(sub1.opts.body), { endpoint: "https://fcm.googleapis.com/fcm/send/NEW", keys: { p256dh: "P".repeat(87), auth: "A".repeat(22) } });
      assert.equal(store.get("xt_chat_push_owner"), "c_001:zz_s1");
      assert.equal(await drive(push.readChatPushState(me), { key: { enabled: true, publicKey: keyB64 } }), "on");
      // 同一个人再打开页面：再交给后端一次，不退
      const n0 = calls.filter((c) => c.url.includes("/push/subscribe")).length;
      await drive(push.syncChatPushOnLoad(me), { subscribe: { ok: true } });
      assert.equal(calls.filter((c) => c.url.includes("/push/subscribe")).length, n0 + 1, "同一个人打开页面没把订阅再交给后端");
      assert.equal(unsubscribed.length, 0);
      // 换人登录（没走退出）：浏览器这边退掉，不帮新的人订
      assert.equal(await drive(push.readChatPushState(other), { key: { enabled: true, publicKey: keyB64 } }), "off", "换人以后显示成「已开启」（那是上一个人开的）");
      await drive(push.syncChatPushOnLoad(other), {});
      assert.deepEqual(unsubscribed, ["https://fcm.googleapis.com/fcm/send/NEW"], "换人登录了，上一个人的订阅没退");
      assert.ok(!store.has("xt_chat_push_owner"));
      // 退出登录：先在浏览器退掉（不用等后端），再告诉后端删
      await drive(push.enableChatPush(me), { key: { enabled: true, publicKey: keyB64 }, subscribe: { ok: true } });
      unsubscribed.length = 0;
      const drop = push.dropChatPushOnLogout(me);
      await settle();
      assert.equal(unsubscribed.length, 1, "退出时没先在浏览器这边退掉（要等后端回了才退，后端卡住就退不掉）");
      const del = pushCalls("unsubscribe").pop();
      assert.ok(del, "退出时没告诉后端删订阅");
      assert.deepEqual(JSON.parse(del!.opts.body), { endpoint: "https://fcm.googleapis.com/fcm/send/NEW" });
      del!.done = true; del!.reject(new Error("令牌已作废")); // 后端删不掉也不能卡住退出
      await drop;
      assert.ok(!store.has("xt_chat_push_owner"));
      // 服务器没配密钥 / 浏览器禁止了 / 不支持
      assert.equal(await drive(push.readChatPushState(me), { key: { enabled: false, publicKey: null } }), "server-off");
      notif.permission = "denied";
      assert.equal(await drive(push.readChatPushState(me), { key: { enabled: true, publicKey: keyB64 } }), "denied");
      delete fakeWindow.PushManager;
      assert.equal(await drive(push.readChatPushState(me), {}), "unsupported");
    } finally {
      delete fakeWindow.localStorage; delete fakeWindow.Notification; delete fakeWindow.PushManager; delete (globalThis as any).Notification;
      if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator); else delete (globalThis as any).navigator;
    }
  });

  await check("U29b 开通知时浏览器的推送服务连不上（国内 Chrome 连不上谷歌，一直不回）：20 秒后报中文、不永远「开启中」；无痕窗口直接报错也换成中文", async () => {
    const push = loadModule(path.join(SRC, "modules/cs-chat/chat-push.ts"), OVERRIDES);
    const store = new Map<string, string>();
    fakeWindow.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
    let mode: "hang" | "reject" = "hang";
    const reg = { pushManager: { getSubscription: async () => null, subscribe: () => (mode === "hang" ? new Promise(() => {}) : Promise.reject(new Error("Registration failed - permission denied"))) } };
    const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Chrome", platform: "Win32", maxTouchPoints: 0, serviceWorker: { getRegistration: async () => reg, register: async () => reg, ready: Promise.resolve(reg) } }, configurable: true, writable: true });
    const notif: any = { permission: "granted", requestPermission: async () => "granted" };
    fakeWindow.Notification = notif; (globalThis as any).Notification = notif; fakeWindow.PushManager = function PushManager() {};
    const me = { role: "client", userId: "ZZC1", companyId: "c_001", token: "t" };
    const answerKey = () => { for (const c of calls.filter((x) => x.url.includes("/client/chat/push/key") && !x.done)) { c.done = true; c.resolve({ enabled: true, publicKey: Buffer.alloc(65, 7).toString("base64url") }); } };
    try {
      let err: any = null; let done = false;
      push.enableChatPush(me).then(() => { done = true; }, (e: any) => { done = true; err = e; });
      await settle(); answerKey(); await settle();
      assert.equal(done, false, "前提：推送服务不回的时候还在等");
      await tickTimers((t) => t.once && t.ms === 20_000);
      await settle();
      assert.ok(done && err, "推送服务一直不回，20 秒后没放弃（按钮会永远「开启中」）");
      assert.match(err.message, /连不上这个浏览器的推送服务[\s\S]*Edge 或火狐/);
      mode = "reject"; err = null; done = false;
      push.enableChatPush(me).then(() => { done = true; }, (e: any) => { done = true; err = e; });
      await settle(); answerKey(); await settle(); await settle();
      assert.ok(err && /无痕/.test(err.message) && !/Registration failed/.test(err.message), `浏览器的英文报错原样给人看了：${err?.message}`);
      assert.ok(!calls.some((c) => c.url.includes("/push/subscribe")), "没订上也去后端存了");
    } finally {
      delete fakeWindow.localStorage; delete fakeWindow.Notification; delete fakeWindow.PushManager; delete (globalThis as any).Notification;
      if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator); else delete (globalThis as any).navigator;
    }
  });

  await check("U30 push-sw.js 真跑：人正对着网页不弹（苹果照弹）；同一对话互相替换；点通知切到已开的窗口、只认本站地址", async () => {
    const vm = await import("node:vm");
    const src = fs.readFileSync(path.join(process.cwd(), "apps/web/public/push-sw.js"), "utf8");
    async function runSw(ua: string, wins: any[]) {
      const handlers: Record<string, (e: any) => void> = {};
      const shown: any[] = [];
      const opened: string[] = [];
      const self: any = {
        navigator: { userAgent: ua },
        location: { origin: "https://xt.example" },
        addEventListener: (t: string, f: any) => { handlers[t] = f; },
        skipWaiting() {},
        clients: { claim: async () => {}, matchAll: async () => wins, openWindow: async (u: string) => { opened.push(u); } },
        registration: { showNotification: async (title: string, opts: any) => { shown.push({ title, ...opts }); } },
      };
      vm.runInNewContext(src, { self, URL });
      const fire = async (type: string, ev: any) => { let w: Promise<any> = Promise.resolve(); handlers[type]({ ...ev, waitUntil: (p: Promise<any>) => { w = p; } }); await w; };
      return { fire, shown, opened };
    }
    const payload = { title: "客户 ZZC1", body: "货到了吗", url: "/staff/chat?clientId=ZZC1", tag: "cs-c-ZZC1" };
    const ev = { data: { json: () => payload } };
    const chrome = "Mozilla/5.0 Chrome/140 Safari/537.36";
    let r = await runSw(chrome, [{ url: "https://xt.example/staff", focused: true }]);
    await r.fire("push", ev);
    assert.equal(r.shown.length, 0, "人正对着网页（网页自己会响），又弹了系统通知");
    r = await runSw(chrome, [{ url: "https://xt.example/staff", focused: false }]);
    await r.fire("push", ev);
    assert.equal(r.shown.length, 1, "网页不在最前面，没弹");
    assert.equal(r.shown[0].title, "客户 ZZC1");
    assert.equal(r.shown[0].tag, "cs-c-ZZC1");
    assert.equal(r.shown[0].renotify, true);
    // 沙箱里造的对象原型不同，按 JSON 比
    assert.deepEqual(JSON.parse(JSON.stringify(r.shown[0].data)), { url: "/staff/chat?clientId=ZZC1" });
    // 苹果：规定每条都要弹（不弹会被收回推送权限）
    r = await runSw("Mozilla/5.0 (iPhone) AppleWebKit Version/17 Mobile Safari/604.1", [{ url: "https://xt.example/client/chat", focused: true }]);
    await r.fire("push", ev);
    assert.equal(r.shown.length, 1, "苹果上人正对着网页就不弹了（会被收回推送权限）");
    // 点通知：有开着的窗口就切过去换到那个对话；地址不是本站的一律回首页
    const navigated: string[] = [];
    const win = { url: "https://xt.example/staff", focused: false, focus: async () => {}, navigate: async (u: string) => { navigated.push(u); } };
    r = await runSw(chrome, [win]);
    await r.fire("notificationclick", { notification: { close() {}, data: { url: "/staff/chat?clientId=ZZC1" } } });
    assert.deepEqual(navigated, ["https://xt.example/staff/chat?clientId=ZZC1"]);
    r = await runSw(chrome, []);
    await r.fire("notificationclick", { notification: { close() {}, data: { url: "https://evil.example/phish" } } });
    assert.deepEqual(r.opened, ["https://xt.example/"], "通知里的外站地址被打开了");
  });

  Date.now = realNow;
  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
