/**
 * 2026-09-27 全系统审查修复 —— 读源码的回归（不连库、不起浏览器）。
 * 每条都是「把修复改回去这条就红」的钉子；改法变了要跟着改，别为了绿把断言放宽。
 *
 *   #5  员工运单列表读产品图必须 select 明确列，且不许带 contentBase64
 *   #1  超管编辑框预填整票量（totalWeightKg / totalVolumeM3），不是父单剩余量
 *   #3  轨迹弹窗按当前页签显示派送信息（tab.lastmile），不是只看父单
 *   #7  超管仓库版页读 warehouseReceiptProofs / thailandReceiptProofs，不再读后端没有的 *Base64 字段
 *   #8  员工集货详情加载时报价三项要复位（不能只在有值时 set）
 *   #9  「柜号」筛选比的是 batchNo（真柜号在这个字段），两端都不再有「批次号」这个多余的框
 *   #10 员工导出总重量/总体积/计费体积用整票量（totalWeightKg ?? weightKg）
 *   #2  代理端 remarkForAgent 接柜号清单并传给 sanitizeRemarkForClient
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
let passed = 0, failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
}

check("#5 员工列表 orderProductImage.findMany 有 select 且不含 contentBase64", () => {
  const src = read("apps/api/src/modules/shipments/routes.ts");
  const i = src.indexOf("prisma.orderProductImage.findMany(");
  assert.ok(i > 0, "没找到 findMany");
  const block = src.slice(i, src.indexOf("})", i) + 2);
  assert.match(block, /select:\s*\{/, "没有 select，会把 content_base64 整列读进内存");
  assert.ok(!/contentBase64/.test(block), "select 里不许有 contentBase64");
  assert.match(block, /filePath:\s*true/, "要取 filePath（列表里 imageUrl 用它）");
});

check("#1 超管编辑框预填用 totalWeightKg ?? weightKg / totalVolumeM3 ?? volumeM3（两处：快照 + 表单）", () => {
  const src = read("apps/web/src/app/admin/page.tsx");
  const i = src.indexOf("const startEditOrder = ");
  const block = src.slice(i, src.indexOf("const rows = (order.products", i));
  const w = block.match(/weightKg:\s*[^,]*totalWeightKg[^,]*,/g) ?? [];
  const v = block.match(/volumeM3:\s*[^,]*totalVolumeM3[^,]*,/g) ?? [];
  assert.equal(w.length, 2, `weightKg 预填要用 totalWeightKg（快照 + 表单各一处），实际 ${w.length} 处`);
  assert.equal(v.length, 2, `volumeM3 预填要用 totalVolumeM3，实际 ${v.length} 处`);
  assert.ok(!/weightKg:\s*order\.weightKg === null/.test(block), "还残留着按剩余量预填的老写法");
});

check("#3 轨迹弹窗派送信息按页签（tab.lastmile），子单页签类型带 lastmile", () => {
  const src = read("apps/web/src/modules/shipment/ShipmentTrackModal.tsx");
  assert.match(src, /\{tab\.lastmile \?/, "派送信息块要读 tab.lastmile");
  assert.ok(!/\{data\.lastmile \?/.test(src), "不能再只读 data.lastmile（父单）");
  const ci = src.indexOf("interface ChildShipmentData");
  assert.match(src.slice(ci, ci + 400), /lastmile\?:/, "ChildShipmentData 要有 lastmile");
  assert.match(src, /lastmile:\s*c\.lastmile/, "allTabs 里子单页签要带上 c.lastmile");
});

check("#7 超管仓库版页用 proofs 数组，不再读 warehouseReceiptBase64 / thailandReceiptBase64", () => {
  const src = read("apps/web/src/app/admin/whr-consolidation/page.tsx");
  assert.ok(!/warehouseReceiptBase64|thailandReceiptBase64/.test(src), "还在读后端没有的 *Base64 字段");
  assert.match(src, /pa\.warehouseReceiptProofs/, "要渲染 warehouseReceiptProofs");
  assert.match(src, /pa\.thailandReceiptProofs/, "要渲染 thailandReceiptProofs");
});

check("#8 员工集货 loadDetail 里报价三项无条件复位", () => {
  const src = read("apps/web/src/app/staff/consolidation/page.tsx");
  const i = src.indexOf("const loadDetail = useCallback");
  const block = src.slice(i, src.indexOf("}, [detailGate]);", i));
  for (const [setter, field] of [["setQuoteBooking", "bookingFee"], ["setQuoteCustoms", "customsFee"], ["setQuoteLoading", "loadingFee"]]) {
    assert.ok(!new RegExp(`if \\(data\\.${field} != null\\) ${setter}`).test(block), `${setter} 还是「只在有值时才 set」，切任务会带上一个任务的数`);
    assert.match(block, new RegExp(`${setter}\\(data\\.${field} != null \\? String\\(data\\.${field}\\) : ""\\)`), `${setter} 要写成 有值填值、没值清空`);
  }
});

check("#9 「柜号」筛选比 batchNo；两端都没有「批次号」筛选框", () => {
  const ef = read("apps/web/src/modules/shipment/export-filter.ts");
  const rows = ef.match(/containerNo:\s*lower\(\[item\.batchNo, item\.containerNo\]/g) ?? [];
  assert.equal(rows.length, 2, `两个 *FilterRow 的 containerNo 都要先比 item.batchNo（再带上装柜号 containerNo），实际 ${rows.length} 处`);
  assert.ok(!/containerNo:\s*lower\(item\.containerNo\)/.test(ef), "还在比从来没人写的 shipments.containerNo");
  for (const p of ["apps/web/src/app/staff/page.tsx", "apps/web/src/app/admin/page.tsx"]) {
    const src = read(p);
    assert.ok(!/key:\s*"batchNo",\s*label:\s*"批次号"/.test(src), `${p} 还有「批次号」筛选框`);
    assert.match(src, /key:\s*"containerNo",\s*label:\s*"柜号"/, `${p} 要保留「柜号」筛选框`);
  }
  // 列表页的搜索面板（员工 / 超管共用）同样不能再有「批次号」框
  const search = read("apps/web/src/modules/shipment/ShipmentSearch.tsx");
  assert.ok(!/\{textField\("batchNo"\)\}/.test(search), "列表搜索面板还有「批次号」框");
  assert.match(search, /\{textField\("containerNo"\)\}/, "列表搜索面板要保留「柜号」框");
});

check("#10 员工导出总重量/总体积/计费体积用整票量", () => {
  const src = read("apps/web/src/app/staff/page.tsx");
  const i = src.indexOf("const rows = source.map((item) => ({");
  const block = src.slice(i, i + 2500);
  assert.match(block, /总件数:\s*totalPackageCountOf\(item\)/, "总件数要跟列表一样用 totalPackageCountOf（整票），不然一行里件数是剩余、重量是整票");
  assert.match(block, /总重量:\s*totalWeightOf\(item\)/, "总重量要跟列表一样用 totalWeightOf（整票）");
  assert.match(block, /总体积:\s*totalVolumeOf\(item\)/, "总体积要跟列表一样用 totalVolumeOf（整票）");
  assert.ok(!/总重量:\s*item\.weightKg \?\?/.test(block), "总重量还在直接用剩余量");
  assert.match(block, /\[billedVolumeCol\]:[\s\S]{0,40}totalVolumeOf\(item\)/, "计费体积也要按整票量算");
});

check("#10b 超管 / 客户 / 代理导出的重量、体积也取整票（跟各自列表一样）", () => {
  for (const [p, re] of [
    ["apps/web/src/app/admin/page.tsx", /重量:\s*totalWeightOf\(o\) \?\? "-", 体积:\s*totalVolumeOf\(o\)/],
    ["apps/web/src/app/admin/page.tsx", /包裹数量:\s*totalPackageCountOf\(o\)/],
    ["apps/web/src/app/client/page.tsx", /重量:\s*totalWeightOf\(o\) \?\? "-", 体积:\s*totalVolumeOf\(o\)/],
    ["apps/web/src/components/agent/AgentShipments.tsx", /重量:\s*o\.totalWeightKg \?\? o\.weightKg[\s\S]{0,20}体积:\s*o\.totalVolumeM3 \?\? o\.volumeM3/],
  ] as const) {
    const src = read(p);
    assert.match(src, re, `${p} 导出的重量/体积要取整票`);
    assert.ok(!/重量:\s*o\.weightKg \?\? "-"/.test(src), `${p} 导出还在直接用剩余量`);
  }
});

check("#2 代理端 remarkForAgent 接柜号清单并传下去", () => {
  const views = read("apps/api/src/modules/agent-portal/views.ts");
  assert.match(views, /export function remarkForAgent\(remark: [^,]+, containerNos: string\[\] = \[\]\)/, "签名要多一个 containerNos");
  assert.match(views, /sanitizeRemarkForClient\(remark \?\? "", true, containerNos\)/, "要把柜号传给 sanitizeRemarkForClient");
  const routes = read("apps/api/src/modules/agent-portal/routes.ts");
  assert.match(routes, /remarkForAgent\(log\.remark, [a-zA-Z]+\)/, "代理查轨迹要把这票货的柜号传进去");
  assert.match(routes, /nextStop:\s*sanitizeRemarkForClient\(log\.nextStop \?\? "", true, familyContainerNos\)/, "代理查轨迹的「下一站」也要按柜号抹");
});

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) process.exit(1);
