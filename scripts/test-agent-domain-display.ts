/**
 * 代理管理里「专属域名」必须看得见（2026-09-19 老板：专属域名应该显示在管理员端设置域名的地方，不然忘记域名是啥了）。
 *
 * 盯住三处：
 *  1. 开代理 / 编辑代理弹窗的「专属域名」那一格 —— 填了就把完整登录网址显示出来（跟「后缀」那一格一样），
 *     空着才显示原来那句提示；手抄成 http://Xxx.Example.com/ 按后端 normalizeAgentDomain 同一口径显示干净的。
 *  2. 代理列表「客户登录链接」那一列 —— 后缀和域名各占一行、带「后缀：/域名：」字样，一眼能认出哪个是域名。
 *  3. 给用户看的字一律写「后缀」，不写「前缀」（2026-09-19 老板：它加在网址末尾，叫前缀会误导）。
 *
 * 写法照 scripts/test-admin-shipment-detail.ts：真编译真渲染 .tsx（不是 grep 源码），列表行是从
 * app/admin/agents/page.tsx 的 AST 里抠出真 JSX 再挂载，页面改了这里跟着变，扫描写窄了会自己报错。
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";

const ts: typeof import("typescript") = createRequire(path.resolve("package.json"))("typescript");

const root = path.resolve("apps/web/src");
const modalEntry = path.join(root, "components/admin/agents/AgentFormModal.tsx");
const requireWeb = createRequire(modalEntry);
const cache = new Map<string, { exports: any }>();

function compile(source: string, filename: string, requireFn: (id: string) => any) {
  const output = ts.transpileModule(source, { fileName: filename, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const module = { exports: {} as any };
  vm.runInNewContext(`(function(exports,require,module){${output}\n})`, {}, { filename })(module.exports, requireFn, module);
  return module.exports;
}
function load(filename: string): any {
  if (cache.has(filename)) return cache.get(filename)!.exports;
  const exported = compile(readFileSync(filename, "utf8"), filename, (id) => {
    if (!id.startsWith(".")) return requireWeb(id);
    const base = path.resolve(path.dirname(filename), id);
    const resolved = [base, base + ".ts", base + ".tsx"].find(existsSync);
    assert.ok(resolved, `Missing import ${id}`);
    return load(resolved);
  });
  cache.set(filename, { exports: exported });
  return exported;
}

const { createElement } = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const ui = load(path.join(root, "components/admin/agents/agent-ui.tsx"));

/* ── 一、弹窗 ── */
const AgentFormModal = load(modalEntry).default;
const agent = {
  id: "a1", name: "雨江测试", slug: "yujiang", customDomain: "yujiang.xianlianth.com",
  loginId: "yujiang", loginStatus: "active", clientCount: 3, logoUrl: "", prices: { normal: 6, inspection: 7, sensitive: 8 },
};
const renderModal = (props: object) => renderToStaticMarkup(createElement(AgentFormModal, { onClose() {}, onSaved() {}, ...props }));

/* ── 二、列表行：从真页面 AST 抠出来挂载 ── */
const pageFile = path.join(root, "app/admin/agents/page.tsx");
const pageSource = readFileSync(pageFile, "utf8");
const ast = ts.createSourceFile(pageFile, pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const rows: any[] = [];
(function visit(node: any) {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === "tr" && node.getText(ast).includes("a.customDomain")) rows.push(node);
  ts.forEachChild(node, visit);
})(ast);
assert.equal(rows.length, 1, "须在代理管理页里定位到渲染 a.customDomain 的那一行（页面改写了就回来对）");

const Row = compile(`export default function Row(ctx: any) {
  const { a, tdS, StatusTag, priceText, btnSmall, btnSmallDanger, busyId, setForm, setResetFor, setNewPassword, setResetError, toggleLogin } = ctx;
  return (${rows[0].getText(ast)});
}`, "mounted-agent-row.tsx", requireWeb).default;

const renderRow = (a: object) => renderToStaticMarkup(createElement("table", null, createElement("tbody", null, createElement(Row, {
  a, tdS: ui.tdS, StatusTag: ui.StatusTag, priceText: ui.priceText, btnSmall: ui.btnSmall, btnSmallDanger: ui.btnSmallDanger, busyId: "",
  setForm() {}, setResetFor() {}, setNewPassword() {}, setResetError() {}, toggleLogin() {},
}))));

let passed = 0;
const failures: string[] = [];
function check(name: string, body: () => void) {
  try { body(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failures.push(name); console.log(`  ❌ ${name}\n     ${e instanceof Error ? e.message : e}`); }
}

console.log("代理管理：专属域名显示");

check("1) 编辑代理：专属域名那一格显示完整登录网址", () => {
  const html = renderModal({ mode: "edit", agent });
  assert.ok(html.includes("客户登录网址："), "没显示「客户登录网址」");
  assert.ok(html.includes("https://yujiang.xianlianth.com"), "没显示完整网址");
});

check("2) 开代理：域名还空着时显示原来的提示，不显示网址", () => {
  const html = renderModal({ mode: "create", agent: null });
  assert.ok(html.includes("只填域名本身"), "空的时候没显示原提示");
  assert.ok(!html.includes("客户登录网址"), "空的时候不该显示网址");
});

check("3) 手抄成 http://Wuliu.Example.com/ 也显示干净网址（跟后端 normalizeAgentDomain 同一口径）", () => {
  const html = renderModal({ mode: "edit", agent: { ...agent, customDomain: "http://Wuliu.Example.com/" } });
  assert.ok(html.includes("https://wuliu.example.com"), "没规整成干净网址");
  assert.ok(!html.includes("https://Wuliu.Example.com"), "把脏输入原样显示了");
});

check("4) 编辑时把已存的域名改掉 → 提示旧域名打不开", () => {
  const html = renderModal({ mode: "edit", agent: { ...agent, customDomain: "old.example.com" } });
  assert.ok(!html.includes("改了以后旧域名打不开"), "没改动时不该有这句");
});

check("5) 列表：后缀和域名各一行、带字样，域名一眼能认出来", () => {
  const html = renderRow({ ...agent, slug: "yujiang", customDomain: "yujiang.xianlianth.com" });
  assert.ok(html.includes("后缀："), "列表没标「后缀：」");
  assert.ok(html.includes("/yujiang"), "列表没显示后缀");
  assert.ok(html.includes("域名："), "列表没标「域名：」");
  assert.ok(html.includes("yujiang.xianlianth.com"), "列表没显示专属域名");
});

check("6) 列表：只设了域名（没后缀）也显示域名", () => {
  const html = renderRow({ ...agent, slug: null, customDomain: "wuliu.example.com" });
  assert.ok(html.includes("域名："), "没标「域名：」");
  assert.ok(html.includes("wuliu.example.com"), "没显示域名");
  assert.ok(!html.includes("后缀："), "没后缀却显示了「后缀：」");
});

check("7) 列表：两样都没设显示「没设」", () => {
  const html = renderRow({ ...agent, slug: null, customDomain: null });
  assert.ok(html.includes("没设"), "没显示「没设」");
});

check("8) 弹窗和列表都写「后缀」，一个字都不许再写「前缀」（老板 2026-09-19：叫前缀会误导）", () => {
  const modal = renderModal({ mode: "create", agent: null });
  assert.ok(modal.includes("后缀（选填）"), "弹窗标签没写「后缀（选填）」");
  assert.ok(!modal.includes("前缀"), "弹窗里还有「前缀」字样");
  const row = renderRow({ ...agent, slug: "yujiang", customDomain: "yujiang.xianlianth.com" });
  assert.ok(row.includes("后缀："), "列表没写「后缀：」");
  assert.ok(!row.includes("前缀"), "列表里还有「前缀」字样");
});

if (failures.length) {
  console.log(`\n${failures.length} 项没过：${failures.join("、")}`);
  process.exit(1);
}
console.log(`\n${passed} 项全过`);
