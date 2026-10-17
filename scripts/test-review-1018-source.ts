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
 *   S7b 真跑页面里那段 submitOrderEdit（Codex / dsh 第 1、2 轮），假后端照真后端核版本：每次保存都带版本；存完基线换成这次提交的；
 *       别人先改了产品行、我只改备注也被拦下（旧产品行配不上新版本，不会漏拦丢数据）；409 不动基线；存的过程中重开弹窗不盖
 *   S10 超管列表 / 导出筛选的「国内单号」也认产品行上的号（Codex / dsh 第 1 轮）
 *   S11 真跑 createClientPrealert + 真 fetchWithSession / parseApiResponse 对本机假服务器：带编号的超时连正文一起管；只有明确的 4xx 算确定没建，
 *       断网 / 到点 / 5xx / 2xx 内容空的坏的读一半断的都标「结果不确定」；还没发出去就拦下的不算（第 2～4 轮）
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

/** 同步版：从真源码里摘一个函数声明出来（S6 要真跑页面里的 newRequestId） */
function sourceNodeSync(file: string, fnName: string): string {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let selected: ts.Node | undefined;
  const walk = (node: ts.Node) => { if (!selected && ts.isFunctionDeclaration(node) && node.name?.text === fnName) selected = node; if (!selected) node.forEachChild(walk); };
  walk(source);
  assert.ok(selected, `真源码里找不到 ${fnName}`);
  return selected!.getText(source);
}
function evalSync(source: string): any {
  const exports = {};
  const sandbox: Record<string, unknown> = { exports, module: { exports }, crypto: globalThis.crypto, Uint8Array, Math, Array };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
  return (sandbox.module as Record<string, unknown>).exports;
}

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
  assert.match(src, /if \(previewRef\.current === batch\) \{\s*setErrors\(errs\);\s*setUnknownCount\(unknown\);\s*setDone\(true\);\s*previewRef\.current = failedRows;\s*setRows\(failedRows\);\s*\}/, "跑完预览只留没下成的（快照一起换）");
  assert.equal((src.match(/failedRows\.push\(/g) ?? []).length, 1, "只有失败分支记");
  // 按钮只看预览有没有行：全成功后预览空了，按钮自然灰
  assert.match(src, /disabled=\{loading \|\| parsing \|\| rows\.length === 0 \|\| badCargoRows\.length > 0\}/);
  // 每行一个请求编号（第 2 轮）：上传解析时给、提交时带上
  assert.match(src, /const normalized = normalizeRows\(raw\)\.map\(\(row\) => \(\{ \.\.\.row, requestId: newRequestId\(\) \}\)\);/, "上传解析时每行要给一个请求编号");
  assert.match(src, /const payload: ClientPrealertPayload = \{\s*requestId: row\.requestId,/, "提交时要带这一行的请求编号");
  // 编号格式要过后端那道（字母数字和「-」、16～64 位）：真跑页面里的 newRequestId
  const fn = sourceNodeSync("apps/web/src/app/client/imports/page.tsx", "newRequestId");
  const gen = evalSync("module.exports=" + fn.replace(/^function newRequestId\(\): string/, "function newRequestId()") + ";");
  const a = gen(); const b = gen();
  assert.ok(/^[A-Za-z0-9-]{16,64}$/.test(a) && a !== b, `请求编号不合后端格式或不随机：${a} / ${b}`);
  const backend = read("apps/api/src/modules/orders/routes.ts");
  assert.ok(backend.includes("!/^[A-Za-z0-9-]{16,64}$/.test(requestId)"), "后端认的编号格式变了，前端这边要跟着核");
  // 结果不确定的行（第 3、4 轮）：单独一句叫客户直接再点、别改了重传；明确失败的另一句叫改好另存（两种混着时两句都在）
  assert.match(src, /unknownCount > 0\s*\?\s*`其中 \$\{unknownCount\} 条是网络或服务器没给准信、不确定有没有建好：请直接再点「一键提交」，不要把这几行改了重新上传（重新上传会当成新单）。`/);
  assert.match(src, /rows\.length > unknownCount\s*\?\s*unknownCount > 0\s*\?\s*`其余 \$\{rows\.length - unknownCount\} 条按上面各自写的原因处理：要改内容的改好另存一张表再上传/);
});

check("S7 超管「运单管理」改单：打开时记订单版本；每次保存都带回去核对（第 2 轮）；存完基线换成刚存的；被抢先就刷新列表", () => {
  const src = code("apps/web/src/app/admin/page.tsx");
  assert.match(src, /useState<\{ form: Record<string, string>; productsJson: string; orderUpdatedAt\?: string \} \| null>\(null\)/);
  assert.match(src, /productsJson: "",\s*orderUpdatedAt: order\.orderUpdatedAt,\s*\}\);/, "打开弹窗要记下订单（不是运单）的 updatedAt");
  assert.match(src, /const saved = await updateAdminOrder\(\{\s*orderId: saveOrderId,\s*\.\.\.\(editSnapshot\?\.orderUpdatedAt \? \{ expectedOrderUpdatedAt: editSnapshot\.orderUpdatedAt \} : \{\}\),/, "每次保存都要带 expectedOrderUpdatedAt（不能只在改产品行时带）");
  assert.ok(!/sendsWholeProducts/.test(src), "又回到「只在改产品行 / 合计时才带版本」了（第 2 轮：只改备注不核对，会把旧产品行配上新版本）");
  assert.match(src, /setEditSnapshot\(\(prev\) => \(prev && prev === snapAtSubmit \? \{ form: submittedForm, productsJson: submittedProductsJson, orderUpdatedAt: saved\.updatedAt \} : prev\)\);/, "存完要把基线整个换成刚存的（只换版本不够）");
  assert.match(src, /if \(\/刚刚被别人改过\/\.test\(text\)\) loadOrders\(\)\.catch\(\(\) => \{\}\);/);
  // 第几次打开弹窗（第 3 轮）：每次打开 +1，保存前记下，报错时还是这一次才写进弹窗（S7b ⑤ 真跑）
  const openAt = src.indexOf("const startEditOrder = ");
  const openBody = src.slice(openAt, src.indexOf("setEditSnapshot({", openAt));
  assert.ok(openAt > 0 && /editSessionRef\.current \+= 1;/.test(openBody), "打开弹窗要给「第几次打开」加一");
  assert.ok(/setMessage\(""\);/.test(openBody), "打开弹窗要先清掉上一回的提示");
  // 关弹窗也 +1（第 4 轮）：三个关的入口都走 closeEditOrder，别处不许再直接 setEditingOrderId("")
  const closeAt = src.indexOf("const closeEditOrder = ");
  const closeBody = src.slice(closeAt, src.indexOf("};", closeAt));
  assert.ok(closeAt > 0 && /editSessionRef\.current \+= 1;\s*setEditingOrderId\(""\);/.test(closeBody), "关弹窗要给「第几次」加一再关");
  assert.equal((src.match(/setEditingOrderId\(""\)/g) ?? []).length, 1, "有地方绕过 closeEditOrder 直接关弹窗");
  assert.match(src, /if \(editingOrderId === \(o\.orderId \?\? o\.id\)\) \{\s*closeEditOrder\(\);/, "再点一次「编辑」要走 closeEditOrder");
  assert.match(src, /<button type="button" onClick=\{closeEditOrder\}[^>]*>取消<\/button>/, "「取消」要走 closeEditOrder");
  // 右上角 ✕（第 5 轮）：DetailModal 先放 0.2 秒动画才调 onClose —— 点 ✕ 那一刻就得 +1，借 confirmClose（点的时候同步调）
  assert.match(src, /title="编辑运单"[\s\S]{0,200}?onClose=\{closeEditOrder\}\s*confirmClose=\{beginCloseEditOrder\}/, "右上角 ✕ 要走 closeEditOrder，并且点下去那一刻就 +1");
  const beginAt = src.indexOf("const beginCloseEditOrder = ");
  assert.ok(beginAt > 0 && /editSessionRef\.current \+= 1;\s*return true;/.test(src.slice(beginAt, src.indexOf("};", beginAt))), "点 ✕ 那一刻要 +1、照常放行");
  const modal = code("apps/web/src/modules/layout/DetailModal.tsx");
  assert.match(modal, /if \(confirmClose && !confirmClose\(\)\) return;[\s\S]{0,200}?window\.setTimeout\(onClose, 200\)/, "DetailModal 得在放动画之前同步问 confirmClose，不然 ✕ 那 0.2 秒照样漏");
  // 离开「运单管理」（浏览器后退也算）：+1（第 5 轮）
  assert.match(src, /const hashId = window\.location\.hash\.replace\(\/\^#\/, ""\);\s*if \(hashId !== "orders"\) editSessionRef\.current \+= 1;/, "离开运单管理要 +1");
  // 存上之后刷新列表失败，不能落进「保存失败」（dsh 第 5 轮；S7b 真跑）
  assert.match(src, /await loadOrders\(\)\.catch\(\(\) => setToast\(`\$\{whose\}订单信息已更新，只是列表这次没刷新上，稍后会自动刷新`\)\);/);
  assert.match(src, /const sessionAtSubmit = editSessionRef\.current;\s*setLoading\(true\);\s*setMessage\(""\);\s*try \{/, "保存前（try 外面）要记下是第几次打开");
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
    const row = (i: number) => ({ rowNo: i + 2, requestId: `req0000000000000${i}`, warehouseId: "wh_yiwu_01", itemName: `货${i}`, packageCount: 1, packageUnit: "box", weightKg: 1, volumeM3: 0.1, shipDate: "2026-10-18", domesticTrackingNo: "", transportMode: "sea", cargoType: "normal", issues: [] });
    let unknownSeen = -1;
    let unknownFail = false;
    const submit = async (rows: Row[], failName: string | null) => {
      unknownSeen = -1;
      const previewRef = { current: rows };
      const sent: string[] = [];
      const ids: string[] = [];
      let lastRows: Row[] | undefined;
      await evalTs("module.exports=" + handler + ";", {
        loading: false, parsing: false, rows, previewRef, isRowBad: () => false,
        setLoading() {}, setCurrent() {}, setSuccessCount() {}, setFailCount() {}, setErrors() {}, setDone() {}, setMessage() {},
        setRows(v: Row[]) { lastRows = v; },
        setUnknownCount(n: number) { unknownSeen = n; },
        createClientPrealert: async (p: Row) => {
          sent.push(p.itemName); ids.push(p.requestId);
          if (p.itemName === failName) throw Object.assign(new Error("网络断了"), unknownFail ? { resultUnknown: true } : {});
        },
      })();
      return { sent, ids, lastRows, preview: previewRef.current, unknown: unknownSeen };
    };
    const first = await submit([row(0), row(1), row(2)], "货1");
    // 沙箱里建的数组跟外面不是同一个 Array（原型不同），比内容用 Array.from 拷出来再比
    assert.deepEqual(first.sent, ["货0", "货1", "货2"]);
    assert.deepEqual(Array.from(first.lastRows ?? [], (r) => r.itemName), ["货1"], "跑完预览要只剩没下成的那行");
    assert.equal(first.preview, first.lastRows, "提交用的快照要跟预览一起换（不然下一次提交认不出是同一份）");
    const retry = await submit(Array.from(first.lastRows!), null);
    assert.deepEqual(retry.sent, ["货1"], "再点只能重交没下成的那行，成功过的不能再下一遍");
    // 每行带自己的请求编号，重交同一行编号不变（服务器认出来就不再建 —— 回话丢了也不重复，第 2 轮）
    assert.deepEqual(first.ids, ["req00000000000000", "req00000000000001", "req00000000000002"]);
    assert.deepEqual(retry.ids, ["req00000000000001"], "重交时请求编号变了，服务器认不出是同一行");
    assert.equal(first.unknown, 0, "明确报错的不算「不确定」");
    // 断网 / 超时（结果不确定）的行：照样留在预览里重交，另外记个数，页面据此提示「别改了重新上传」（第 3 轮）
    unknownFail = true;
    const shaky = await submit([row(0), row(1)], "货1");
    assert.equal(shaky.unknown, 1, "结果不确定的行要单独记数");
    assert.deepEqual(Array.from(shaky.lastRows ?? [], (r) => r.itemName), ["货1"]);
    assert.ok(retry.lastRows !== undefined && retry.lastRows.length === 0, "全成功后预览清空（按钮跟着变灰）");
  });

  await checkAsync("S7b 真跑超管「运单管理」的 submitOrderEdit（假后端照真后端核版本）：每次都带版本；存完基线换成这次提交的；别人先改了产品行、我只改备注也被拦下，旧产品行配不上新版本；409 不动基线；存的过程中又开了一次弹窗不盖", async () => {
    const editTotals = await import("../apps/web/src/modules/orders/edit-totals");
    const guard = await import("../apps/web/src/modules/orders/productRowGuard");
    const handler = sourceNode("apps/web/src/app/admin/page.tsx", (n) => ts.isArrowFunction(n) && ts.isVariableDeclaration(n.parent) && n.parent.name.getText() === "submitOrderEdit");
    const F0: Row = {
      clientId: "ZZC1", trackingNo: "ZZ-1", batchNo: "B0", warehouseId: "wh_yiwu_01", itemName: "鞋", transportMode: "sea", domesticTrackingNo: "",
      receiverAddressTh: "", containerNo: "", productQuantity: "0", packageCount: "2", packageUnit: "box", weightKg: "10", volumeM3: "0.1",
      cargoType: "normal", paymentStatus: "unpaid", shipDate: "2026-10-18", remark: "R0",
    };
    const P0 = [{ id: "p1", itemName: "鞋", packageCount: "2", lengthCm: "", widthCm: "", heightCm: "", productQuantity: "", weightKg: "", cargoType: "normal", domesticTrackingNo: "SF1" }];
    // 假后端：跟 /admin/orders/update 一样，带了 expectedOrderUpdatedAt 就锁里核对，对不上 409、什么都不写
    const server: Row = { version: 0, products: JSON.parse(JSON.stringify(P0)) };
    const sent: Row[] = [];
    const store: Row = {};
    let duringSave: ((payload: Row) => void) | null = null;
    let loadFails = false;
    const session = { current: 0 };
    // 打开一次弹窗 = startEditOrder：第几次打开 +1、基线换成库里现在的样子
    const open = () => { session.current += 1; store.snapshot = { form: { ...F0 }, productsJson: JSON.stringify(P0), orderUpdatedAt: `V${server.version}` }; };
    const save = async (form: Row, products: Row[]) => {
      store.message = "";
      store.toast = "";
      await evalTs("module.exports=" + handler + ";", {
        editSessionRef: session,
        // 沙箱自带一份 Error，假后端抛的是外面这份：handler 里 `error instanceof Error` 认不出、报错文字被吞成「保存失败」——换成同一份
        Error,
        ...editTotals, ...guard, loading: false, editingOrderId: "o1", orderEditForm: form, editProducts: products, editSnapshot: store.snapshot,
        setLoading() {}, setMessage(m: string) { store.message = m; }, setToast(t: string) { store.toast = t; },
        setEditSnapshot(v: any) { store.snapshot = typeof v === "function" ? v(store.snapshot) : v; },
        updateAdminOrder: async (payload: Row) => {
          sent.push(JSON.parse(JSON.stringify(payload)));
          if (duringSave) { const f = duringSave; duringSave = null; f(payload); }
          if (payload.expectedOrderUpdatedAt !== undefined && payload.expectedOrderUpdatedAt !== `V${server.version}`) {
            throw new Error("这票刚刚被别人改过（超管端「运单管理」或别的超管），你这次没有保存。请关掉重新打开，看最新的再改");
          }
          if (Array.isArray(payload.products)) server.products = payload.products;
          server.version += 1;
          return { orderId: "o1", updatedAt: `V${server.version}` };
        },
        loadOrders: async () => { if (loadFails) throw new Error("列表接口断网了"); return "applied"; },
      })();
      return sent[sent.length - 1];
    };
    const last = () => sent[sent.length - 1];

    // ① 同时改备注和一行产品：带打开时的版本 V0；存完基线 = 这次提交的那份
    open();
    const P1 = [{ ...P0[0], packageCount: "3" }];
    const typedDuringSave: Row = { ...F0, remark: "R1" };
    duringSave = () => { typedDuringSave.batchNo = "正在输的"; }; // 保存还没回来，人又在批次号里打了字
    await save(typedDuringSave, P1);
    assert.equal(last().expectedOrderUpdatedAt, "V0", "每次保存都要带打开时的版本");
    assert.ok(Array.isArray(last().products));
    assert.equal(store.snapshot.orderUpdatedAt, "V1");
    assert.equal(store.snapshot.form.remark, "R1");
    assert.equal(store.snapshot.form.batchNo, "B0", "基线要用点保存那一刻发出去的，不能把保存期间新输的当成已存");
    assert.equal(store.snapshot.productsJson, JSON.stringify(P1), "产品行基线要换成这次提交的");
    // ② 同一弹窗接着只改批次号：不再发备注、不再发产品行，带 V1
    await save({ ...F0, remark: "R1", batchNo: "B1" }, P1);
    assert.equal(last().expectedOrderUpdatedAt, "V1");
    assert.ok(!("remark" in last()) && !("products" in last()), `第一次存过的又发了一遍：${JSON.stringify(last())}`);
    assert.equal(last().batchNo, "B1");

    // ③ 丢数据那条链（Codex / dsh 第 2 轮）：我打开以后，别人把产品行改了；我只改备注 —— 必须被拦下，基线不动；再改产品行也照样被拦
    open();
    server.products = [{ ...P0[0], packageCount: "8" }, { id: "p2", itemName: "帽", packageCount: "1" }];
    server.version += 1; // 别人存了一次
    const before = store.snapshot;
    await save({ ...F0, remark: "只改备注" }, JSON.parse(store.snapshot.productsJson));
    assert.match(store.message ?? "", /刚刚被别人改过/, `别人改过产品行，我只改备注也得拦下（不拦的话旧产品行会配上新版本）。发的：${JSON.stringify(last())}；提示：${store.message}`);
    assert.equal(store.snapshot, before, "被拦下的那次不能动基线");
    await save({ ...F0, remark: "只改备注" }, [{ ...P0[0], packageCount: "5" }]);
    assert.match(store.message ?? "", /刚刚被别人改过/);
    assert.deepEqual(server.products.map((p: Row) => p.itemName), ["鞋", "帽"], "别人加的那行被删了");

    // ④ 存的过程中关掉又开了一次（同一张单也一样）：回来以后不盖新弹窗的基线
    open();
    duringSave = () => { open(); };
    const reopened = () => store.snapshot;
    await save({ ...F0, remark: "R9" }, P0.map((p) => ({ ...p })));
    assert.notEqual(reopened().form.remark, "R9", "存的过程中重开了弹窗，新弹窗的基线被这次保存盖了");
    assert.match(store.toast ?? "", /^之前那张单：订单信息已更新/, "存的过程中换了弹窗，成功提示要写明是之前那张");

    // ⑤ 保存还没回来就关了、打开了别的单，这次又被拦下（Codex 第 3 轮）：报错不能写进新弹窗，改用提示条说「之前那张没存上」
    open();
    server.version += 1; // 别人先存了，这次必然 409
    duringSave = () => { open(); };
    await save({ ...F0, remark: "R10" }, P0.map((p) => ({ ...p })));
    assert.equal(store.message, "", `旧请求的报错写进了新打开的弹窗：${store.message}`);
    assert.match(store.toast ?? "", /之前那张单没存上：.*刚刚被别人改过/);
    // 同一个弹窗里被拦：照旧写进弹窗
    open();
    server.version += 1;
    await save({ ...F0, remark: "R11" }, P0.map((p) => ({ ...p })));
    assert.match(store.message ?? "", /保存失败：.*刚刚被别人改过/);
    // 同一个弹窗里存成功：提示照旧
    open();
    await save({ ...F0, remark: "R12" }, P0.map((p) => ({ ...p })));
    assert.match(store.toast ?? "", /^订单信息已更新/);
    // ⑥ 保存还没回来就点「取消」关了、没打开别的单（第 4 轮两家必须修）：用页面里真的 closeEditOrder 关；被拦的报错走提示条，不写进关掉的弹窗
    const closeEditOrder = evalTs("module.exports=" + sourceNode("apps/web/src/app/admin/page.tsx", (n) => ts.isArrowFunction(n) && ts.isVariableDeclaration(n.parent) && n.parent.name.getText() === "closeEditOrder") + ";", {
      editSessionRef: session, setEditingOrderId() {},
    });
    open();
    server.version += 1;
    duringSave = () => { closeEditOrder(); };
    await save({ ...F0, remark: "R13" }, P0.map((p) => ({ ...p })));
    assert.equal(store.message, "", `关掉的弹窗里写了报错，人看不见：${store.message}`);
    assert.match(store.toast ?? "", /之前那张单没存上：.*刚刚被别人改过/);
    // 关了不重开、这次存成功：提示写明之前那张
    open();
    duringSave = () => { closeEditOrder(); };
    await save({ ...F0, remark: "R14" }, P0.map((p) => ({ ...p })));
    assert.match(store.toast ?? "", /^之前那张单：订单信息已更新/);
    // ⑦ 点了右上角 ✕、还在放 0.2 秒关闭动画（closeEditOrder 还没调），保存这时被拦（第 5 轮两家必须修）：
    //    点 ✕ 那一刻 DetailModal 同步调的是 confirmClose = 页面里真的 beginCloseEditOrder
    const beginCloseEditOrder = evalTs("module.exports=" + sourceNode("apps/web/src/app/admin/page.tsx", (n) => ts.isArrowFunction(n) && ts.isVariableDeclaration(n.parent) && n.parent.name.getText() === "beginCloseEditOrder") + ";", {
      editSessionRef: session,
    });
    open();
    server.version += 1;
    duringSave = () => { assert.equal(beginCloseEditOrder(), true, "confirmClose 要放行"); };
    await save({ ...F0, remark: "R15" }, P0.map((p) => ({ ...p })));
    assert.equal(store.message, "", `✕ 动画那 0.2 秒里回来的报错写进了正在关的弹窗：${store.message}`);
    assert.match(store.toast ?? "", /之前那张单没存上：.*刚刚被别人改过/);
    // ⑧ 存上了、接着刷新列表失败（dsh 第 5 轮）：不能说成「保存失败」，基线照样换成刚存的
    open();
    loadFails = true;
    await save({ ...F0, remark: "R16" }, P0.map((p) => ({ ...p })));
    loadFails = false;
    assert.equal(store.message, "", `存上了却显示：${store.message}`);
    assert.match(store.toast ?? "", /^订单信息已更新，只是列表这次没刷新上/);
    assert.equal(store.snapshot.form.remark, "R16", "存上了基线要换成刚存的");
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
    assert.ok(search(f.staffShipmentFilterRow(item as any), "sf2001"), "员工那份照旧认产品行上的号");
  });

  await checkAsync("S11 真跑 createClientPrealert + 真 fetchWithSession / parseApiResponse，对一个本机假服务器（第 2～4 轮）：带编号的超时连正文一起管；只有明确的 4xx 算确定没建、原样抛，断网 / 到点 / 5xx / 2xx 内容空的坏的读一半断的都标「结果不确定」；还没发出去就拦下的不算；不带编号的照旧不加超时、不改报错", async () => {
    const http = await import("node:http");
    const core = await import("../apps/web/src/services/core-api");
    let mode = "ok";
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits++;
      if (mode === "destroy") { req.socket.destroy(); return; }
      req.resume();
      req.on("end", () => {
        const json = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
        switch (mode) {
          case "hang": res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"code":"OK","data":{'); return; // 回了响应头，正文一直不结束
          case "cut200": res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"code":"OK","da'); setTimeout(() => req.socket.destroy(), 20); return; // 读到一半断了
          case "html502": res.writeHead(502, { "Content-Type": "text/html" }); res.end("<html><body>502 Bad Gateway</body></html>"); return;
          case "cn500": json(500, { code: "INTERNAL_ERROR", message: "数据库连接断了。" }); return;
          case "c409": json(409, { code: "VALIDATION_ERROR", message: "请求编号已经被用过了，请刷新页面后重新上传" }); return;
          case "b400": json(400, { code: "VALIDATION_ERROR", message: "仓库填错了" }); return;
          case "empty200": res.writeHead(200); res.end(); return;
          case "html200": res.writeHead(200, { "Content-Type": "text/html" }); res.end("<html>代理换掉的页面</html>"); return;
          case "okNoData": json(200, { code: "OK" }); return;
          case "okNull": json(200, { code: "OK", data: null }); return;
          case "okEmpty": json(200, { code: "OK", data: {} }); return;
          case "okOther": json(200, { code: "OK", data: { prealertId: "o_req_someoneelse000000", createdAt: "2026-10-18T00:00:00.000Z" } }); return;
          case "okPlain": json(200, { code: "OK", data: { prealertId: "o_1792270210323_l5hr", createdAt: "2026-10-18T00:00:00.000Z" } }); return;
          default: json(200, { code: "OK", data: { prealertId: "o_req_req00000000000000", createdAt: "2026-10-18T00:00:00.000Z" } });
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const fnText = sourceNode("apps/web/src/services/business-api.ts", (n) => ts.isFunctionDeclaration(n) && n.name?.text === "createClientPrealert");
      let initSeen: any = null;
      const createClientPrealert = evalTs(fnText.replace(/^export /, "") + "\nmodule.exports = createClientPrealert;", {
        Error, TypeError, AbortController, setTimeout, clearTimeout, STAFF_ORDER_TIMEOUT_MS: 300,
        apiBaseUrl: () => base, authHeaders: () => ({}),
        // 跟 business-api 一样用 fetchWithSession（`fetchWithSession as fetch`）和 parseApiResponse，都是真的
        fetch: (u: string, init: Row) => { initSeen = init; return core.fetchWithSession(u, init); },
        parseApiResponse: core.parseApiResponse,
      });
      const withId = { requestId: "req00000000000000", warehouseId: "wh_yiwu_01", packageCount: 1 };
      const run = async (m: string, payload: Row = withId): Promise<any> => {
        mode = m;
        // 再套一层 3 秒：超时没管到正文时这里会一直等，别让整个测试挂住
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            createClientPrealert(payload).then((v: any) => ({ value: v }), (e: any) => e),
            new Promise((r) => { watchdog = setTimeout(() => r(new Error("3 秒了还没回来：超时没管到")), 3000); }),
          ]);
        } finally { clearTimeout(watchdog); }
      };
      // ① 回了响应头、正文一直不结束：到点（这里 300 毫秒）连正文一起断，标不确定
      const t0 = Date.now();
      const e1 = await run("hang");
      assert.equal(e1?.resultUnknown, true, `正文卡住：${e1?.message}`);
      assert.ok(Date.now() - t0 < 2000, "正文卡住要按超时断开");
      assert.match(e1.message, /^网络中断或服务器太久没回应。这一行可能已经下单了/);
      // ② 断网（连接被掐，fetch 抛 TypeError）、③ 正文读到一半断了
      for (const m of ["destroy", "cut200"]) {
        const e = await run(m);
        assert.equal(e?.resultUnknown, true, `${m}：${e?.message}`);
      }
      // ④ 网关 502（英文网页）、⑤ 后端自己的 500（中文原因）：都不确定；后端写的原因留着
      const e4 = await run("html502");
      assert.equal(e4?.resultUnknown, true);
      assert.match(e4.message, /^服务器出错了，请稍后再试（反复出现请联系技术）。这一行可能已经下单了/);
      const e5 = await run("cn500");
      assert.equal(e5?.resultUnknown, true);
      assert.match(e5.message, /^数据库连接断了。这一行可能已经下单了/);
      // ⑥ 回的是 200 但内容是空的 / 被换成了网页（Codex 第 4 轮）：后端可能已经建好了，同样不确定
      for (const m of ["empty200", "html200"]) {
        const e = await run(m);
        assert.equal(e?.resultUnknown, true, `${m}：${e?.message}`);
        assert.match(e.message, /^服务器回的内容不完整。这一行可能已经下单了/);
      }
      // ⑦ 后端明确拒了（409 别人的编号 / 400 填错）：原样抛、不标不确定
      const e7 = await run("c409");
      assert.equal(e7?.message, "请求编号已经被用过了，请刷新页面后重新上传");
      assert.ok(!e7?.resultUnknown);
      const e8 = await run("b400");
      assert.equal(e8?.message, "仓库填错了");
      assert.ok(!e8?.resultUnknown);
      // ⑧ 成功照常返回（回的就是这一行那张 o_req_<编号>）
      const ok = await run("ok");
      assert.equal(ok?.value?.prealertId, "o_req_req00000000000000");
      // ⑧b 回了 200、code 也是 OK，但没带单子 / 是空的 / 是别的单（第 5 轮 Codex）：不能当成功把这行拿掉，标不确定
      for (const m of ["okNoData", "okNull", "okEmpty", "okOther"]) {
        const e = await run(m);
        assert.equal(e?.resultUnknown, true, `${m} 被当成成功了：${JSON.stringify(e?.value ?? e?.message)}`);
        assert.match(e.message, /^服务器回的内容不完整。这一行可能已经下单了/);
      }
      // ⑨ 还没发出去就拦下的（内容太大）：服务器什么都没收到，确定没建，不标不确定
      const before = hits;
      const big = await run("ok", { ...withId, remark: "x".repeat(core.REQUEST_BODY_MAX_BYTES + 10) });
      assert.equal(hits, before, "内容太大的不该发出去");
      assert.ok(big instanceof Error && !(big as { resultUnknown?: boolean }).resultUnknown && /太大/.test(big.message), `内容太大：${big?.message}`);
      // ⑩ 不带编号（单张下单）：不加超时、不改报错
      const noId = { warehouseId: "wh_yiwu_01", packageCount: 1 };
      const e10 = await run("destroy", noId);
      assert.ok(initSeen && !("signal" in initSeen), "不带编号的不该加超时");
      assert.ok(e10 instanceof TypeError && !(e10 as { resultUnknown?: boolean }).resultUnknown, `不带编号断网：${e10?.message}`);
      const e11 = await run("empty200", noId);
      assert.ok(e11 instanceof Error && !(e11 as { resultUnknown?: boolean }).resultUnknown);
      const plain = await run("okPlain", noId);
      assert.equal(plain?.value?.prealertId, "o_1792270210323_l5hr", "不带编号的照旧认随机单号");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  console.log(`\n${passed} 项通过，${failed} 项失败`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
