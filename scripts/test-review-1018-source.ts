/**
 * 2026-10-18 全系统审查（6 个 Codex 分块 + dsh，逐条核实 64 条）老板选 B 修的 6 处 —— 不连库的那一半。
 * 清单和核实依据：.audit/2026-10-18/full-review/核实结果.md（第一档 1～5 + 第二档第 6 条）；改坏验证记录在 .audit/2026-10-18/review-fix/。
 *
 *   S1  国内单号导出口径 domesticNosLabel：产品行的号按顺序去重拼「、」、没号的行是「货拉拉」、整票另有真单号补在后面、整票是「货拉拉」不补、没产品行用整票
 *   S2  员工 / 超管 / 客户三端导出 + 代理端导出和列表都用它（原来只拿整票那个号，线上 317 张多款订单会漏号）
 *   S3  超管「创建订单」建成后表单清空（原来带着上一单的产品行）；没建成不清
 *   S4  超管「批量导入运单」导入中只能「停止导入」：每条开头看停没停、停了弹窗不自动关、说清哪几行没导（原来「取消」只关弹窗、后面照建）
 *   S4b 真跑页面里那段导入循环：第 2 条建完点停 → 只建 2 条、停在第 3 行、弹窗不关；不点停照旧全建、全成功自动关
 *   S5  deploy.sh「保留旧容器」的几处都带 --no-recreate，只有最后真切换那一句不带（原来改库失败也会按新镜像重建容器）
 *   S6  客户「批量下单」跑完预览只留没下成的行（原来按钮还亮着、整批再点一次全部重下）
 *   S6b 真跑页面里那段 handleSubmit：3 行第 2 行失败 → 预览只剩第 2 行；再交一次只重交它，成功后预览清空
 *   S7  超管「运单管理」改单：打开时记下订单版本，改了产品行 / 合计才带回去核对；存完换成新版本；被抢先就刷新列表
 *   S7b 真跑页面里那段 submitOrderEdit（Codex / dsh 第 1 轮）：存完基线整个换成刚存的 —— 接着改别的再存，第一次存过的字段不再发；
 *       再改产品行带的是刚返回的新版本；存的过程中换了别的单，那边的基线不被盖
 *   S10 超管列表 / 导出筛选的「国内单号」也认产品行上的号（Codex / dsh 第 1 轮）
 *   S8  超管在员工页「保存订单信息」：草稿带订单版本、保存带回去；存完先换新版本
 *   S9  后端：两份列表给订单的 updatedAt；patch-shipment-bundle 锁住订单后核版本；两条改单路写订单时 updatedAt 跟返回值同一个 now
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { domesticNosLabel } from "../packages/shared-types/product-names";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** 去掉注释再查，别让注释里的老写法 / 说明骗过检查 */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
}

check("S1 国内单号导出口径：产品行按顺序去重、空号当「货拉拉」、整票真单号补在后面、整票「货拉拉」不补、没产品行用整票", () => {
  // 产品行各有号：按 sortOrder 排、去重
  assert.equal(domesticNosLabel([{ domesticTrackingNo: "SF2", sortOrder: 1 }, { domesticTrackingNo: "SF1", sortOrder: 0 }, { domesticTrackingNo: "SF1", sortOrder: 2 }], null), "SF1、SF2");
  // 没填号的行存的是「货拉拉」（也可能是空 / null），照样列出来
  assert.equal(domesticNosLabel([{ domesticTrackingNo: "SF1", sortOrder: 0 }, { domesticTrackingNo: "货拉拉", sortOrder: 1 }], ""), "SF1、货拉拉");
  assert.equal(domesticNosLabel([{ domesticTrackingNo: "  ", sortOrder: 0 }, { domesticTrackingNo: null, sortOrder: 1 }], null), "货拉拉");
  // 整票上另有一个真单号、产品行里没有：补在最后（线上 254 张）
  assert.equal(domesticNosLabel([{ domesticTrackingNo: "SF1", sortOrder: 0 }], "YT9"), "SF1、YT9");
  // 整票就是其中一个：不重复
  assert.equal(domesticNosLabel([{ domesticTrackingNo: "SF1", sortOrder: 0 }, { domesticTrackingNo: "SF2", sortOrder: 1 }], "SF2"), "SF1、SF2");
  // 整票是「货拉拉」占位：不补（线上 626 张，补了每行都多一个货拉拉）
  assert.equal(domesticNosLabel([{ domesticTrackingNo: "SF1", sortOrder: 0 }], "货拉拉"), "SF1");
  // 没有产品行的老单：整票的号；都没有：空串（调用方写「-」）
  assert.equal(domesticNosLabel([], " YT9 "), "YT9");
  assert.equal(domesticNosLabel(undefined, null), "");
  // 代理接口的产品行不带 sortOrder（后端已按 sortOrder 排好）：保持原顺序
  assert.equal(domesticNosLabel([{ domesticTrackingNo: "B" }, { domesticTrackingNo: "A" }], null), "B、A");
});

check("S2 三端导出 + 代理端导出 / 列表的「国内单号」都用 domesticNosLabel（产品行 + 整票），不再只拿整票那个号", () => {
  const uses: Array<[string, RegExp]> = [
    ["apps/web/src/app/client/page.tsx", /国内单号: domesticNosLabel\(o\.products, o\.domesticTrackingNo\) \|\| "-",/],
    ["apps/web/src/app/staff/page.tsx", /国内单号: domesticNosLabel\(item\.products, item\.domesticTrackingNo\) \|\| "-",/],
    ["apps/web/src/app/admin/page.tsx", /国内单号: domesticNosLabel\(o\.products, o\.domesticTrackingNo\) \|\| "-",/],
    ["apps/web/src/components/agent/AgentShipments.tsx", /国内单号: domesticNosLabel\(o\.products, o\.domesticTrackingNo\) \|\| "-",/],
  ];
  for (const [rel, re] of uses) {
    const src = code(rel);
    assert.match(src, re, `${rel} 的导出没用 domesticNosLabel`);
    assert.ok(!/国内单号: (o|item)\.domesticTrackingNo \?\?/.test(src), `${rel} 还有只拿整票号的导出`);
    assert.match(src, /import \{[^}]*\bdomesticNosLabel\b[^}]*\} from "[./]+\/packages\/shared-types\/product-names";/, `${rel} 没从共用包导入 domesticNosLabel`);
  }
  const agent = code("apps/web/src/components/agent/AgentShipments.tsx");
  assert.match(agent, /<td style=\{td\}>\{domesticNosLabel\(o\.products, o\.domesticTrackingNo\) \|\| "—"\}<\/td>/, "代理端运单列表那一格也要带产品行的号");
  assert.ok(!/\{o\.domesticTrackingNo \?\? "—"\}/.test(agent), "代理端列表还在只显示整票号");
});

check("S3 超管「创建订单」：建成以后（关弹窗之后）表单和产品行清回空单；初值、加行也用同一份空单；没建成的分支不清", () => {
  const src = code("apps/web/src/app/admin/page.tsx");
  const form = src.match(/function blankCreateOrderForm\(\) \{\s*return \{([\s\S]*?)\};\s*\}/);
  assert.ok(form, "找不到 blankCreateOrderForm");
  for (const k of ['clientId: ""', 'trackingNo: ""', 'domesticTrackingNo: ""', "arrivedAt: beijingToday()"]) assert.ok(form![1].includes(k), `空单里缺 ${k}`);
  assert.match(src, /function blankCreateProduct\(\) \{\s*return \{ itemName: "", packageCount: "", lengthCm: "", widthCm: "", heightCm: "", productQuantity: "", cargoType: "normal", domesticTrackingNo: "" \};\s*\}/);
  assert.match(src, /useState\(blankCreateOrderForm\)/, "createForm 初值要用 blankCreateOrderForm");
  assert.match(src, /\}>>\(\(\) => \[blankCreateProduct\(\)\]\);/, "createProducts 初值要用 blankCreateProduct");
  assert.match(src, /setCreateProducts\(\[\.\.\.createProducts, blankCreateProduct\(\)\]\)/, "「添加产品行」也用同一份空行");
  // 建成那段：关弹窗后清空；清空在 catch / return 之后（没建成走不到）
  assert.match(src, /setCreateOrderMessage\(`创建失败：[^`]*`\);\s*\n\s*return;\s*\n\s*\} finally \{ setCreatingOrder\(false\); \}\s*setToast\("订单创建成功"\);\s*setShowCreateOrderModal\(false\);\s*setCreateForm\(blankCreateOrderForm\(\)\);\s*setCreateProducts\(\[blankCreateProduct\(\)\]\);/, "建成后要清空表单（且只在建成之后）");
  assert.equal((src.match(/setCreateForm\(blankCreateOrderForm\(\)\)/g) ?? []).length, 1, "清空只在建成那一处");
});

check("S4 超管「批量导入运单」：导入中只给「停止导入」（不关弹窗），建单循环每条开头看停没停；停了不自动关、说清哪几行没导；重新开始先把「停」清掉", () => {
  const src = code("apps/web/src/app/admin/page.tsx");
  assert.match(src, /const batchStopRef = useRef\(false\);/);
  // 导入中那个键只记「停」，不关弹窗、不清数据
  const stopBtn = src.match(/\{batchLoading \? \(\s*<button type="button" disabled=\{batchStopping\} onClick=\{\(\) => \{ ([^}]*) \}\}/);
  assert.ok(stopBtn, "导入中要换成「停止导入」键");
  assert.equal(stopBtn![1].trim(), "batchStopRef.current = true; setBatchStopping(true);", "「停止导入」只能记一个停，不能关弹窗 / 清数据");
  assert.match(src, />\{batchStopping \? "正在停止…" : "停止导入"\}<\/button>/);
  // 循环：开跑清掉上一次的停；每条开头先看停没停，停了记下停在第几条再跳出
  assert.match(src, /batchStopRef\.current = false;\s*setBatchStopping\(false\);\s*setBatchStoppedAt\(null\);\s*let stoppedAt: number \| null = null;/);
  assert.match(src, /for \(let i = 0; i < batchRows\.length; i\+\+\) \{\s*if \(batchStopRef\.current\) \{ stoppedAt = i; break; \}\s*const r = batchRows\[i\];/, "每条开头要先看停没停");
  // 停了：弹窗不自动关（自动关只在没停、全成功时）
  assert.match(src, /if \(stoppedAt !== null\) \{\s*setBatchStoppedAt\(stoppedAt\);\s*setToast\(`已停止导入[^`]*`\);\s*\} else if \(fail === 0\) \{/, "停下来的分支要排在「全成功自动关弹窗」前面");
  assert.match(src, /第 \{batchStoppedAt \+ 1\}～\{batchRows\.length\} 行没有导入/, "弹窗里要说清哪几行没导");
  // 关弹窗那个键（不在导入中时）把「停在第几条」清掉
  assert.match(src, /setBatchProgress\(\{ current: 0, success: 0, fail: 0 \}\); setBatchStoppedAt\(null\); \}\}/);
});

check("S5 deploy.sh：「保留旧容器」的几处 up -d 都带 --no-recreate，只有「构建成功、数据库就绪，切换容器」后面那一句真切换", () => {
  const lines = read("deploy.sh").split("\n");
  const cmds = lines.map((l, i) => ({ l: l.trim(), i })).filter(({ l }) => /^docker compose up\b/.test(l));
  assert.ok(cmds.length >= 5, `deploy.sh 里 docker compose up 只找到 ${cmds.length} 处`);
  const plain = cmds.filter(({ l }) => !/--no-recreate/.test(l));
  assert.equal(plain.length, 1, `不带 --no-recreate 的 up 应该只剩最后切换那一句：${plain.map((p) => `第${p.i + 1}行 ${p.l}`).join("；")}`);
  assert.match(lines[plain[0].i - 1] ?? "", /echo "✅ 构建成功、数据库就绪，切换容器\.\.\."/, "唯一真切换的那句必须紧跟在「构建成功、数据库就绪」后面");
  assert.equal(plain[0].l, "docker compose up -d");
  // 失败分支：每个 exit 1 前面的 up 都带 --no-recreate（构建失败、结构缺字段、备份 / 迁移没成）
  const src = read("deploy.sh");
  for (const marker of ["⛔ 构建失败，保留旧容器", "⛔ 数据库缺少设计图里的字段", "⛔ 数据库没准备好，**不切换新容器**"]) {
    const at = src.indexOf(marker);
    assert.ok(at >= 0, `找不到「${marker}」`);
    const tail = src.slice(at, src.indexOf("exit 1", at));
    assert.match(tail, /docker compose up -d --no-recreate/, `「${marker}」那个分支保留旧容器要带 --no-recreate`);
  }
});

check("S6 客户「批量下单」：失败的行记下来，跑完预览只留它们（成功的拿掉）—— 再点只重试没下成的，全成功按钮就灰了", () => {
  const src = code("apps/web/src/app/client/imports/page.tsx");
  assert.match(src, /const failedRows: ImportRow\[\] = \[\];/);
  assert.match(src, /errs\.push\(`表格第\$\{row\.rowNo\}行\(\$\{row\.itemName\}\): \$\{text\}`\);\s*failedRows\.push\(row\);/, "失败的行要记下来");
  assert.match(src, /if \(previewRef\.current === batch\) \{\s*setErrors\(errs\);\s*setDone\(true\);\s*previewRef\.current = failedRows;\s*setRows\(failedRows\);\s*\}/, "跑完预览只留没下成的（快照一起换）");
  assert.equal((src.match(/failedRows\.push\(/g) ?? []).length, 1, "只有失败分支记");
  // 按钮只看预览有没有行：全成功后预览空了，按钮自然灰
  assert.match(src, /disabled=\{loading \|\| parsing \|\| rows\.length === 0 \|\| badCargoRows\.length > 0\}/);
});

check("S7 超管「运单管理」改单：打开时记订单版本；改了产品行 / 合计才带回去核对；存完换成返回的新版本；被抢先就刷新列表", () => {
  const src = code("apps/web/src/app/admin/page.tsx");
  assert.match(src, /useState<\{ form: Record<string, string>; productsJson: string; orderUpdatedAt\?: string \} \| null>\(null\)/);
  assert.match(src, /productsJson: "",\s*orderUpdatedAt: order\.orderUpdatedAt,\s*\}\);/, "打开弹窗要记下订单（不是运单）的 updatedAt");
  assert.match(src, /const sendsWholeProducts = productsChanged \|\| manualTotalsChanged;[\s\S]{0,600}?const saved = await updateAdminOrder\(\{\s*orderId: saveOrderId,\s*\.\.\.\(sendsWholeProducts && editSnapshot\?\.orderUpdatedAt \? \{ expectedOrderUpdatedAt: editSnapshot\.orderUpdatedAt \} : \{\}\),/, "改了产品行 / 合计要带 expectedOrderUpdatedAt");
  // 产品行 / 合计发出去的条件跟带版本的条件是同一个口径
  assert.match(src, /\.\.\.\(productsChanged \? \{\s*productQuantity: totalProductQuantity,/);
  assert.match(src, /\.\.\.\(productsChanged \|\| manualTotalsChanged \? \{\s*weightKg: finalWeight,/);
  assert.match(src, /setEditSnapshot\(\(prev\) => \(prev && prev === snapAtSubmit \? \{ form: submittedForm, productsJson: submittedProductsJson, orderUpdatedAt: saved\.updatedAt \} : prev\)\);/, "存完要把基线整个换成刚存的（只换版本不够）");
  assert.match(src, /if \(\/刚刚被别人改过\/\.test\(text\)\) loadOrders\(\)\.catch\(\(\) => \{\}\);/);
  // 后端报的那句跟这里认的一样
  assert.match(read("apps/api/src/modules/admin/routes.ts"), /这票刚刚被别人改过（超管端「运单管理」或别的超管），你这次没有保存/);
});

check("S8 超管在员工页「保存订单信息」：草稿记订单版本、保存带回去、存完先换成返回的新版本", () => {
  assert.match(code("apps/web/src/modules/staff/utils.ts"), /baseOrderUpdatedAt: item\.orderUpdatedAt \?\? null,/);
  assert.match(code("apps/web/src/modules/staff/types.ts"), /baseOrderUpdatedAt: string \| null;/);
  const src = code("apps/web/src/app/staff/page.tsx");
  assert.match(src, /const saved = await patchStaffShipmentOrderBundle\(\{\s*shipmentId,\s*\.\.\.\(draft\.baseOrderUpdatedAt \? \{ expectedOrderUpdatedAt: draft\.baseOrderUpdatedAt \} : \{\}\),/);
  assert.match(src, /setShipmentOrderEditDrafts\(\(prev\) => \(prev\[shipmentId\] \? \{ \.\.\.prev, \[shipmentId\]: \{ \.\.\.prev\[shipmentId\], baseOrderUpdatedAt: saved\.updatedAt \} \} : prev\)\);\s*const shipmentItems = await loadPageData\(\);/, "存完先换版本、再刷新");
  const api = code("apps/web/src/services/business-api.ts");
  const fnAt = api.indexOf("export async function patchStaffShipmentOrderBundle(");
  const sig = api.slice(fnAt, api.indexOf("{\n", api.indexOf("}): Promise<", fnAt)));
  assert.ok(fnAt >= 0 && /expectedOrderUpdatedAt\?: string;/.test(sig), "patchStaffShipmentOrderBundle 的参数里要有 expectedOrderUpdatedAt");
  assert.ok(/\}\): Promise<\{ shipmentId: string; orderId: string; updatedAt: string \}>/.test(sig), "patchStaffShipmentOrderBundle 要把返回的 updatedAt 交给页面");
});

check("S9 后端：两份列表给订单 updatedAt；patch-shipment-bundle 锁住订单之后、动别的之前核版本；两条改单路写订单的 updatedAt 跟返回值同一个 now", () => {
  assert.match(code("apps/api/src/modules/admin/routes.ts"), /orderUpdatedAt: r\.order\?\.updatedAt\?\.toISOString\(\),/);
  assert.match(code("apps/api/src/modules/shipments/routes.ts"), /orderUpdatedAt: r\.order\?\.updatedAt\?\.toISOString\(\),/);
  const orders = code("apps/api/src/modules/orders/routes.ts");
  const start = orders.indexOf('app.post("/staff/orders/patch-shipment-bundle"');
  const route = orders.slice(start, orders.indexOf("app.", start + 10));
  const lockAt = route.indexOf("FOR NO KEY UPDATE`;");
  const checkAt = route.indexOf("body.expectedOrderUpdatedAt");
  const childLockAt = route.indexOf("await lockShipmentsChildrenFirst(tx, [shipmentId], auth.companyId);");
  assert.ok(lockAt > 0 && checkAt > lockAt && childLockAt > checkAt, "核版本要在锁住订单之后、锁运单 / 写库之前");
  assert.match(route, /if \(!cur \|\| cur\.updatedAt\.toISOString\(\) !== body\.expectedOrderUpdatedAt\) \{\s*throw new BusinessError\("这票刚刚被别人改过[^"]*", 409, "VALIDATION_ERROR"\);/);
  assert.match(route, /createdAt: arrived,\s*updatedAt: now,\s*\},\s*\}\);/, "patch-shipment-bundle 写订单要带 updatedAt: now（跟返回值一样）");
  assert.match(route, /ok\(res, \{[\s\S]*?updatedAt: now\.toISOString\(\),/);
  const admin = code("apps/api/src/modules/admin/routes.ts");
  assert.match(admin, /await tx\.order\.update\(\{ where: \{ id: orderId \}, data: \{ cargoType: productCargo, updatedAt: now \} \}\);/, "超管改单第二次写订单（货型）也要用同一个 now");
});

/* ---------- 真跑页面代码的两项（同 test-cargo-regressions 的做法：从真源码里摘那段函数，换掉 React 的 setter 再执行） ---------- */
type Row = Record<string, any>;
function evalTs(source: string, context: Row = {}): any {
  const exports = {};
  const sandbox = { exports, module: { exports }, console, setTimeout, clearTimeout, ...context };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, sandbox);
  return (sandbox.module as Row).exports;
}
function sourceNode(file: string, predicate: (node: ts.Node) => boolean): string {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let selected: ts.Node | undefined;
  const walk = (node: ts.Node) => { if (!selected && predicate(node)) selected = node; if (!selected) node.forEachChild(walk); };
  walk(source);
  assert.ok(selected, `真源码里找不到那段：${file}`);
  return selected!.getText(source);
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
}

async function main(): Promise<void> {
  await checkAsync("S4b 真跑超管批量导入那段：第 2 条建完点「停止导入」→ 只建 2 条、停在第 3 行、弹窗不自动关；不点停照旧全建、全成功自动关", async () => {
    const cargoModule = await import("../packages/shared-types/cargo-type");
    const staffModule = await import("../apps/web/src/modules/staff/batchOrderImport");
    const handler = sourceNode("apps/web/src/app/admin/page.tsx", (n) => ts.isArrowFunction(n) && n.getText().includes("await createStaffOrder({") && n.getText().includes("setBatchFailures(failures)"));
    const run = async (count: number, stopAfter: number | null) => {
      const stopRef = { current: true }; // 上一轮留下的「停」：开跑要先清掉，不然一条都不建
      const made: Row[] = [];
      const seen = { stoppedAt: [] as unknown[], closed: 0, toast: [] as string[] };
      const rows = Array.from({ length: count }, (_, i) => ({ "客户ID": "fixture_client", "品名": "鞋", "箱数": 1, "运单号": `YW-STOP-${i}`, "到仓日期": "2026-10-18" }));
      await evalTs("module.exports=" + handler + ";", {
        ...cargoModule, ...staffModule, batchRows: rows, beijingToday: () => "2026-10-18",
        setBatchLoading() {}, setBatchProgress() {}, setBatchFailures() {}, setBatchDone() {}, setBatchRows() {}, setBatchConfirmed() {}, setBatchStopping() {},
        setToast(t: string) { seen.toast.push(t); }, setShowBatchImport(v: boolean) { if (v === false) seen.closed++; }, setBatchStoppedAt(v: unknown) { seen.stoppedAt.push(v); },
        batchStopRef: stopRef, loadOrders: async () => {},
        createStaffOrder: async (payload: Row) => { made.push(payload); if (stopAfter !== null && made.length === stopAfter) stopRef.current = true; },
      })();
      return { made, seen };
    };
    const stopped = await run(5, 2);
    assert.equal(stopped.made.length, 2, `点了「停止导入」以后还在建：建了 ${stopped.made.length} 条`);
    assert.deepEqual(stopped.seen.stoppedAt.filter((v) => v !== null), [2], "要记下停在第几条");
    assert.equal(stopped.seen.closed, 0, "停下来的弹窗不能自动关（要让人看到哪几行没导）");
    assert.match(stopped.seen.toast[stopped.seen.toast.length - 1] ?? "", /已停止导入：处理了 2 条（成功 2，失败 0），第 3 行起没导入/);
    const full = await run(3, null);
    assert.equal(full.made.length, 3, "没点停：上一轮留下的「停」要清掉、照旧全建");
    assert.deepEqual(full.seen.stoppedAt.filter((v) => v !== null), [], "没停不能记停在哪");
    assert.equal(full.seen.closed, 1, "没停、全成功照旧自动关弹窗");
  });

  await checkAsync("S6b 真跑客户「批量下单」的 handleSubmit：3 行第 2 行失败 → 预览只剩第 2 行；再交一次只重交它，成功后预览清空", async () => {
    const handler = sourceNode("apps/web/src/app/client/imports/page.tsx", (n) => ts.isArrowFunction(n) && ts.isVariableDeclaration(n.parent) && n.parent.name.getText() === "handleSubmit");
    const row = (i: number) => ({ rowNo: i + 2, warehouseId: "wh_yiwu_01", itemName: `货${i}`, packageCount: 1, packageUnit: "box", weightKg: 1, volumeM3: 0.1, shipDate: "2026-10-18", domesticTrackingNo: "", transportMode: "sea", cargoType: "normal", issues: [] });
    const submit = async (rows: Row[], failName: string | null) => {
      const previewRef = { current: rows };
      const sent: string[] = [];
      let lastRows: Row[] | undefined;
      await evalTs("module.exports=" + handler + ";", {
        loading: false, parsing: false, rows, previewRef, isRowBad: () => false,
        setLoading() {}, setCurrent() {}, setSuccessCount() {}, setFailCount() {}, setErrors() {}, setDone() {}, setMessage() {},
        setRows(v: Row[]) { lastRows = v; },
        createClientPrealert: async (p: Row) => { sent.push(p.itemName); if (p.itemName === failName) throw new Error("网络断了"); },
      })();
      return { sent, lastRows, preview: previewRef.current };
    };
    const first = await submit([row(0), row(1), row(2)], "货1");
    // 沙箱里建的数组跟外面不是同一个 Array（原型不同），比内容用 Array.from 拷出来再比
    assert.deepEqual(first.sent, ["货0", "货1", "货2"]);
    assert.deepEqual(Array.from(first.lastRows ?? [], (r) => r.itemName), ["货1"], "跑完预览要只剩没下成的那行");
    assert.equal(first.preview, first.lastRows, "提交用的快照要跟预览一起换（不然下一次提交认不出是同一份）");
    const retry = await submit(Array.from(first.lastRows!), null);
    assert.deepEqual(retry.sent, ["货1"], "再点只能重交没下成的那行，成功过的不能再下一遍");
    assert.ok(retry.lastRows !== undefined && retry.lastRows.length === 0, "全成功后预览清空（按钮跟着变灰）");
  });

  await checkAsync("S7b 真跑超管「运单管理」的 submitOrderEdit：存完基线换成刚存的 —— 接着改别的再存，第一次存过的字段不再发；再改产品行带刚返回的新版本；存的过程中换了别的单不盖那边的基线", async () => {
    const editTotals = await import("../apps/web/src/modules/orders/edit-totals");
    const guard = await import("../apps/web/src/modules/orders/productRowGuard");
    const handler = sourceNode("apps/web/src/app/admin/page.tsx", (n) => ts.isArrowFunction(n) && ts.isVariableDeclaration(n.parent) && n.parent.name.getText() === "submitOrderEdit");
    const F0: Row = {
      clientId: "ZZC1", trackingNo: "ZZ-1", batchNo: "B0", warehouseId: "wh_yiwu_01", itemName: "鞋", transportMode: "sea", domesticTrackingNo: "",
      receiverAddressTh: "", containerNo: "", productQuantity: "0", packageCount: "2", packageUnit: "box", weightKg: "10", volumeM3: "0.1",
      cargoType: "normal", paymentStatus: "unpaid", shipDate: "2026-10-18", remark: "R0",
    };
    const P0 = [{ id: "p1", itemName: "鞋", packageCount: "2", lengthCm: "", widthCm: "", heightCm: "", productQuantity: "", weightKg: "", cargoType: "normal", domesticTrackingNo: "SF1" }];
    // 模拟 React：state 放在 store 里，每次「点保存」都用当时的 state 重新取一份闭包（跟重新渲染一样）
    const store: Row = { snapshot: { form: { ...F0 }, productsJson: JSON.stringify(P0), orderUpdatedAt: "V0" } };
    const sent: Row[] = [];
    let version = 0;
    let duringSave: (() => void) | null = null;
    const save = async (form: Row, products: Row[]) => {
      await evalTs("module.exports=" + handler + ";", {
        ...editTotals, ...guard, loading: false, editingOrderId: "o1", orderEditForm: form, editProducts: products, editSnapshot: store.snapshot,
        setLoading() {}, setMessage(m: string) { store.message = m; }, setToast() {},
        setEditSnapshot(v: any) { store.snapshot = typeof v === "function" ? v(store.snapshot) : v; },
        updateAdminOrder: async (payload: Row) => { sent.push(JSON.parse(JSON.stringify(payload))); if (duringSave) { duringSave(); duringSave = null; } version += 1; return { orderId: "o1", updatedAt: `V${version}` }; },
        loadOrders: async () => "applied",
      })();
    };
    // 第一次：只改备注 R0 → R1
    await save({ ...F0, remark: "R1" }, P0);
    assert.equal(sent[0].remark, "R1");
    assert.ok(!("products" in sent[0]) && !("expectedOrderUpdatedAt" in sent[0]), "只改单个字段不发产品行、不带版本");
    assert.equal(store.snapshot.form.remark, "R1", "存完基线要换成刚存的备注");
    assert.equal(store.snapshot.orderUpdatedAt, "V1");
    // 第二次（同一弹窗）：只改批次号 —— 不能再把第一次的备注发一遍（别人这期间改的备注会被盖回）
    await save({ ...F0, remark: "R1", batchNo: "B1" }, P0);
    assert.equal(sent[1].batchNo, "B1");
    assert.ok(!("remark" in sent[1]), `第一次存过的备注又发了一遍：${JSON.stringify(sent[1])}`);
    assert.ok(!("products" in sent[1]), "产品行没动不能整组发");
    // 第三次：改产品行 —— 带刚返回的新版本 V2，不是打开时的 V0
    const P1 = [{ ...P0[0], packageCount: "3" }];
    await save({ ...F0, remark: "R1", batchNo: "B1" }, P1);
    assert.equal(sent[2].expectedOrderUpdatedAt, "V2", `改产品行带的版本不对：${sent[2].expectedOrderUpdatedAt}`);
    assert.ok(Array.isArray(sent[2].products));
    // 存的过程中关掉又开了别的单（基线换成了别人的）：回来以后不能用这次的去盖它
    const other = { form: { ...F0, trackingNo: "ZZ-2" }, productsJson: "[]", orderUpdatedAt: "W0" };
    duringSave = () => { store.snapshot = other; };
    await save({ ...F0, remark: "R9", batchNo: "B1" }, P1);
    assert.equal(store.snapshot, other, "存的过程中换了别的单，那张单的基线被这次保存盖了");
  });

  await checkAsync("S10 超管列表 / 导出筛选的「国内单号」也认产品行上的号（导出带了，筛选得跟上）；员工那份照旧认", async () => {
    // 路径放变量里动态取：export-filter 引了 .tsx，测试脚本那份 tsconfig 没开 jsx，写死字面量 tsc 会去解析它报错
    const filterPath = "../apps/web/src/modules/shipment/export-filter";
    const f: any = await import(filterPath);
    const item = { trackingNo: "ZZ-1", domesticTrackingNo: "货拉拉", products: [{ itemName: "鞋", domesticTrackingNo: "SF2001" }, { itemName: "包", domesticTrackingNo: "YT9" }] };
    const search = (row: Row, kw: string) => f.matchesShipmentFilter(row as any, { ...f.EMPTY_SHIPMENT_FILTER, domesticTrackingNo: kw });
    assert.ok(search(f.adminOrderFilterRow(item as any), "sf2001"), "超管按产品行上的国内单号筛不出来");
    assert.ok(search(f.adminOrderFilterRow(item as any), "yt9"));
    assert.ok(search(f.adminOrderFilterRow(item as any), "货拉拉"), "整票上的号照旧认");
    assert.ok(!search(f.adminOrderFilterRow(item as any), "zz404"));
  });

  console.log(`\n${passed} 项通过，${failed} 项失败`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
