/**
 * 2026-09-28 上线前整条分支审查查出来的页面 bug —— 不连库、不起浏览器的回归。
 * 能真跑的都真跑（把仓库里的真函数转译出来调），跑不了的读源码钉住。每条都是「改回去就红」。
 * 后端那几条在 test-branch-review-0928-db.ts；聊天窗口的点击行为在 test-cs-chat-ui-behavior.ts。
 *
 *   V1 员工 / 超管运单列表的筛选（列表搜索和导出弹窗共用）按表上显示的整票数比，不按父单剩余量比
 *   V2 客户批量导入：运输方式没填 / 认不出来标红、不许提交（原来一律悄悄当海运）
 *   V3 整柜询价报价：认「这一次打开的详情」—— 关了 / 换了一张也提示成败、刷新列表；关了又开同一张，旧的保存回来不冲掉新填的
 *   V4 已收货（received）在客户详情、客户导出、超管导出、代理导出里都写中文
 *   V5 运费低消「保存中」真的会显示、按钮会灰（原来那个状态从来没人置成 true）；后端两个一起存
 *   V6 父单轨迹接口查子单派送单明着写 select（上线自检要求；也免得把用不上的列读出来）
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
let passed = 0, failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
}

/** 把一个 .ts / .tsx 模块编译出来直接调（跟 test-shipment-export 同一套办法） */
function loadModule(rel: string): Record<string, any> {
  const filename = join(ROOT, rel);
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const moduleObject = { exports: {} as Record<string, any> };
  vm.runInNewContext("(function(exports,require,module){" + output + "\n})", { console }, { filename })(
    moduleObject.exports, createRequire(filename), moduleObject,
  );
  return moduleObject.exports;
}

/** 从源码里按名字取出一个顶层函数 / 常量声明的原文 */
function topLevelText(rel: string, names: string[]): string {
  const src = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, rel.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const parts: string[] = [];
  for (const st of src.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && names.includes(st.name.text)) parts.push(st.getText(src));
    if (ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && names.includes(d.name.text))) parts.push(st.getText(src));
  }
  assert.equal(parts.length, names.length, `源码里没找全：${names.join("、")}`);
  return parts.join("\n");
}

check("V1 拆过柜的单（父单剩 30 / 30 kg / 0.3 方，整票 100 / 100 kg / 1 方）：按表上看到的 100 筛得到，按 30 反而筛不到", () => {
  const f = loadModule("apps/web/src/modules/shipment/export-filter.ts");
  const item = {
    trackingNo: "T1", packageCount: 30, weightKg: 30, volumeM3: 0.3,
    totalPackageCount: 100, totalWeightKg: 100, totalVolumeM3: 1, products: [],
  };
  for (const [who, rowFn] of [["员工", f.staffShipmentFilterRow], ["超管", f.adminOrderFilterRow]] as const) {
    const row = rowFn(item);
    assert.equal(row.packageCount, "100", `${who}：件数比的不是整票`);
    assert.equal(row.weightKg, "100", `${who}：重量比的不是整票`);
    assert.equal(row.volumeM3, "1", `${who}：体积比的不是整票`);
    assert.equal(f.matchesShipmentFilter(row, { ...f.EMPTY_SHIPMENT_FILTER, weightKg: "100" }), true, `${who}：按表上的「100」筛不到`);
    assert.equal(f.matchesShipmentFilter(row, { ...f.EMPTY_SHIPMENT_FILTER, weightKg: "30" }), false, `${who}：按父单剩余「30」还筛得到`);
  }
  // 有产品行的：件数按产品行加起来（跟列表那一列同一个函数）
  const withProducts = f.staffShipmentFilterRow({ ...item, products: [{ packageCount: 60 }, { packageCount: 40 }] });
  assert.equal(withProducts.packageCount, "100");
  // 老数据拿不到整票数：照旧退回原字段，不能变成空
  const legacy = f.adminOrderFilterRow({ trackingNo: "T2", packageCount: 8, weightKg: 12.5, volumeM3: 0.2 });
  assert.equal(legacy.packageCount, "8"); assert.equal(legacy.weightKg, "12.5"); assert.equal(legacy.volumeM3, "0.2");
});

check("V2 客户批量导入：运输方式 海运 / 海 / sea / 陆运 / 陆 / land 认得；没填、「空运」「海陆」认不出 → null（标红、不许提交）", () => {
  const rel = "apps/web/src/app/client/imports/page.tsx";
  const cargo = loadModule("packages/shared-types/cargo-type.ts");
  const code = topLevelText(rel, ["WAREHOUSE_ZH", "WAREHOUSE_BY_NAME", "normalizeRows"]);
  const js = ts.transpileModule(code + "\nmodule.exports = normalizeRows;", { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const sandbox: any = { module: { exports: {} }, parseCargoType: cargo.parseCargoType };
  vm.runInNewContext(js, sandbox);
  const normalizeRows = sandbox.module.exports;
  const row = (tm: string) => ({ "仓库 *": "义乌仓", "品名 *": "鞋", "箱数 *": 2, "运输方式 *（海运/陆运）": tm });
  const cases: Array<[string, string | null]> = [
    ["海运", "sea"], ["海", "sea"], ["SEA", "sea"], [" 陆运 ", "land"], ["陆", "land"], ["land", "land"],
    ["", null], ["空运", null], ["海陆", null], ["陆运/海运", null],
  ];
  for (const [raw, want] of cases) {
    const [r] = normalizeRows([row(raw)]);
    assert.ok(r, `运输方式「${raw}」这一行被悄悄丢掉了（应留在预览里标红）`);
    assert.equal(r.transportMode, want, `运输方式「${raw}」认成了 ${r.transportMode}`);
  }
  const src = read(rel);
  assert.match(src, /entry\.row\.transportMode === null/, "提交按钮没拦认不出来的运输方式");
  assert.match(src, /row\.transportMode === null\s*\? \(row\.transportModeRaw \? `「\$\{row\.transportModeRaw\}」认不出来` : "没填"\)/, "预览里没把认不出来的运输方式标出来");
});

check("V3 整柜询价报价（写法钉子；真点的在 test-cs-chat-ui-behavior U8 / U9）：同一张单报价没回来不许再报；刷新现在这一页；详情关了成败照样提示", () => {
  const src = read("apps/web/src/components/client/FclInquiryPanel.tsx");
  const i = src.indexOf("const saveQuote = async () => {");
  const body = src.slice(i, src.indexOf("\n  };", i));
  assert.match(body, /if \(savingQuoteIdsRef\.current\.has\(id\)\) \{ setQuoteMessage\(/, "同一张单上一次报价还没回来，照样能再报");
  assert.match(body, /savingQuoteIdsRef\.current\.add\(id\);/);
  assert.match(body, /finally \{\s*savingQuoteIdsRef\.current\.delete\(id\);/);
  assert.match(body, /const seq = detailSeqRef\.current;/, "报价没记下是哪一次打开的详情");
  assert.match(body, /loadList\(listPageRef\.current\);\s*if \(detailSeqRef\.current === seq\) await openDetail\(id\);/, "要刷新「现在这一页」；重新加载详情只在还是同一次打开时做");
  assert.match(body, /if \(detailSeqRef\.current === seq\) setQuoteMessage\(msg\);\s*else props\.onToast\(msg\);/, "详情关了 / 换了，报价失败一声不吭");
  assert.match(src, /listPageRef\.current = listPage;/);
  assert.match(src, /disabled=\{savingQuoteIds\.includes\(detail\.id\)\}/, "按钮没按「这张单在不在保存」变灰");
});

check("V4 已收货（received）写中文：客户详情、客户导出、超管导出、代理导出", () => {
  const client = read("apps/web/src/app/client/page.tsx");
  assert.match(client, /审批状态: [^\n]*o\.approvalStatus === "received" \? "已收货"/, "客户导出");
  assert.match(client, /审批状态：<\/span>\{[^\n]*item\.approvalStatus === "received" \? "已收货"/, "客户详情");
  assert.match(read("apps/web/src/app/admin/page.tsx"), /审批状态: [^\n]*o\.approvalStatus === "received" \? "已收货"/, "超管导出");
  assert.match(read("apps/web/src/components/agent/AgentShipments.tsx"), /const APPROVAL_ZH: Record<string, string> = \{[^}]*received: "已收货"/, "代理导出");
});

check("V5 运费低消：点保存后按钮灰、写「保存中…」，结束复原；后端两个值放在一个事务里存", () => {
  const src = read("apps/web/src/components/admin/ShippingConfig.tsx");
  assert.match(src, /disabled=\{props\.configSaving \|\| minSaving\}/);
  assert.match(src, /setMinSaving\(true\);\s*try \{\s*await updateShippingConfig/);
  assert.match(src, /finally \{\s*setMinSaving\(false\);/);
  assert.match(src, /\{props\.configSaving \|\| minSaving \? "保存中…" : "保存配置"\}/);
  const api = read("apps/api/src/modules/shipping-config/routes.ts");
  assert.match(api, /await prisma\.\$transaction\(async \(tx\) => \{\s*for \(const \[key, text\] of toSave\) await saveConfig\(key, text, tx\);/, "两个低消没放进同一个事务");
});

check("V6 父单轨迹查子单派送单：明着写 select，只要派送信息那几列", () => {
  const src = read("apps/api/src/modules/containers/routes.ts");
  const i = src.indexOf("const childLastmileRows = childShipments.length > 0");
  const block = src.slice(i, src.indexOf(": [];", i));
  assert.match(block, /select: \{\s*shipmentId: true, carrierName: true, driverName: true, licensePlate: true,\s*phoneNumber: true, signImageBase64: true, status: true,\s*\}/, "子单派送单没有明着写 select");
});

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) process.exit(1);
