/**
 * 「待入库」在各端的显示（2026-10-08 到货通知全面审查 F03 / F04 / F07 / F08 / F10 / F13 / F16 / G02；修复第 1 轮：员工详情按整票、客户预报单表状态格）。
 * 到货通知转待入库时：运输方式存空串；件数没填 —— 运单存 null、订单表不许空只能存 0（0 = 没填）、不建产品行；品名可能是空串。
 * 这些「没填」在页面、导出里一律显示「—」/「-」，不许变成假的「陆运」「0 箱」或空白；打印要拦住，不许猜成「箱号 1/1」。
 * 不连库、不起页面；能真跑的真跑（共享组件 / 工具函数），页面里的写法读源码核。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const read = (p: string) => readFileSync(p, "utf8");
let passed = 0; let failed = 0;
function check(name: string, run: () => void) {
  try { run(); passed++; console.log("✅", name); } catch (e) { failed++; console.log("❌", name, "\n  ", e instanceof Error ? e.message : e); }
}
function loadTsx(file: string, globals: Record<string, unknown> = {}) {
  const filename = path.resolve(file);
  const requireWeb = createRequire(filename);
  const out = ts.transpileModule(read(filename), { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const mod = { exports: {} as Record<string, any> };
  vm.runInNewContext("(function(exports,require,module){" + out + "\n})", { ...globals }, { filename })(mod.exports, requireWeb, mod);
  return { mod: mod.exports, requireWeb };
}

const CLIENT = "apps/web/src/app/client/page.tsx";
const STAFF = "apps/web/src/app/staff/page.tsx";
const ADMIN = "apps/web/src/app/admin/page.tsx";
const AGENT = "apps/web/src/components/agent/AgentShipments.tsx";

check("F04 运输方式：transportModeLabel 空串 / null 显示「—」；客户页面不许再有「不是海运就是陆运」的写法", () => {
  const { mod } = loadTsx("apps/web/src/modules/staff/utils.ts");
  assert.equal(mod.transportModeLabel(""), "—");
  assert.equal(mod.transportModeLabel(null), "—");
  assert.equal(mod.transportModeLabel(undefined), "—");
  assert.equal(mod.transportModeLabel("sea"), "海运");
  assert.equal(mod.transportModeLabel("land"), "陆运");
  const client = read(CLIENT);
  const bad = client.match(/=== "sea" \? "海运" : "陆运"/g) ?? [];
  assert.equal(bad.length, 0, `客户页面还有 ${bad.length} 处空串会显示成「陆运」（首页预报单表 / 预报单页）`);
  // 三张表的运输方式格都走同一个 transportTag（只有 sea / land 才画彩色标签）
  assert.equal((client.match(/\{transportTag\(item\.transportMode\)\}/g) ?? []).length, 3, "客户三张表的运输方式格应该都走 transportTag");
  assert.match(client, /function transportTag\(mode: string \| null \| undefined\) \{\s*if \(mode !== "sea" && mode !== "land"\) return "—";/);
  // R9：transportTag 不许夹在 import 中间
  const lastImport = [...client.matchAll(/^import .*$/gm)].at(-1)!.index!;
  assert.ok(client.indexOf("function transportTag(") > lastImport, "transportTag 写在了 import 中间");
});

check("F04 员工详情的运输方式下拉：不是 sea / land 时取值为空、多一个「—」选项，不让草稿兜底的「海运」冒充真数据", () => {
  const staff = read(STAFF);
  assert.match(staff, /value=\{item\.transportMode === "sea" \|\| item\.transportMode === "land" \? draft\.transportMode : ""\}/);
  assert.match(staff, /item\.transportMode === "sea" \|\| item\.transportMode === "land" \? null : <option value="">—<\/option>/);
});

check("F13 / F16 客户、代理导出的运输方式走 transportModeLabel（空串「—」、sea/land 中文）", () => {
  assert.match(read(CLIENT), /运输方式:\s*transportModeLabel\(o\.transportMode\)/);
  assert.match(read(AGENT), /运输方式:\s*transportModeLabel\(o\.transportMode\)/);
});

check("F03 件数 0 = 没填：客户三张表、客户 / 代理导出、代理列表都不直接输出 packageCount；导出品名空时写「-」、两张预报单表品名空时写「—」", () => {
  const client = read(CLIENT);
  assert.ok(!/\{item\.packageCount\} \{/.test(client), "客户页面还有 `{item.packageCount} {箱/袋}` 的直出写法");
  assert.equal((client.match(/\{packageCountText\(item\.packageCount, /g) ?? []).length, 3, "客户三张表的件数格应该都走 packageCountText");
  assert.match(client, /包裹数量:\s*knownPackageCount\(o\.packageCount\) \?\? "-"/);
  assert.match(client, /品名: productNamesLabel\(o\.products, o\.itemName\) \|\| "-"/);
  // 首页预报单表、「预报单」页的品名格（修复审查补）：待入库没填品名时 productNamesLabel 真返回空串，格子要兜「—」
  const { mod: names } = loadTsx("packages/shared-types/product-names.ts");
  assert.equal(names.productNamesLabel([], ""), "", "productNamesLabel 没品名时返回空串，页面得自己兜");
  assert.equal((client.match(/<td style=\{\{ padding: "6px 8px" \}\}>\{productNamesLabel\(item\.products, item\.itemName\) \|\| "—"\}<\/td>/g) ?? []).length, 2, "首页预报单表、「预报单」页的品名格都要兜「—」");
  assert.ok(!/\{productNamesLabel\(item\.products, item\.itemName\)\}<\/td>/.test(client), "客户页面还有没兜底的品名格（没填品名就是空白）");
  assert.match(read(ADMIN), /品名: productNamesLabel\(o\.products, o\.itemName\) \|\| "-"/);
  const agent = read(AGENT);
  assert.match(agent, /包裹数量:\s*knownPackageCount\(o\.packageCount\) \?\? "-"/);
  assert.ok(!/<td style=\{tdNum\}>\{o\.packageCount\}<\/td>/.test(agent), "代理列表还直接输出件数");
  assert.match(agent, /<td style=\{tdNum\}>\{knownPackageCount\(o\.packageCount\) \?\? "—"\}<\/td>/);
  assert.match(agent, /\{o\.productNames \|\| o\.itemName \|\| "—"\}<\/td>/);
});

check("F03 员工详情的件数：待入库且不是正数时显示空、提示「未填」（两个件数框）；修复第 1 轮：件数 / 重量 / 体积按整票（跟列表「总箱数」一致），不显示父单剩余量", () => {
  const staff = read(STAFF);
  // shipmentDetailTotalsText 里 0 / null 一律是空串（真跑见 test-shipment-list-display.ts），待入库再挂「未填」占位
  const hits = staff.match(/value=\{totals\.packageCount\}\s*placeholder=\{item\.currentStatus === "pendingInbound" \? "未填" : undefined\}\s*readOnly/g) ?? [];
  assert.equal(hits.length, 2, `员工详情两个件数框应该都显示整票件数、处理待入库，实际 ${hits.length}`);
  assert.match(staff, /const totals = shipmentDetailTotalsText\(item\);/);
  assert.ok(!/value=\{[^}]*draft\.packageCount/.test(staff), "员工详情还有直出 draft.packageCount（父单剩余件数）的件数框");
  assert.ok(!/value=\{draft\.weightKg\}/.test(staff), "「总重量」还在显示父单剩余重量");
  assert.ok(!/value=\{draft\.volumeM3\}/.test(staff), "「总体积 / 计费体积」还在显示父单剩余体积");
  assert.equal((staff.match(/value=\{totals\.volumeM3\}/g) ?? []).length, 2, "总体积、计费体积");
  assert.equal((staff.match(/value=\{totals\.weightKg\}/g) ?? []).length, 1, "总重量");
});

check("修复第 1 轮 客户预报单表状态格：按审批状态四种说（员工建的 / 到货通知转出来的是「已审核」，不是「已发货」）；导出同一份", () => {
  const { mod } = loadTsx("apps/web/src/modules/orders/prealert-status.ts");
  assert.equal(mod.prealertStatusTag("approved").label, "已审核", "到货通知转出来的（含待入库）原来显示「已发货」");
  assert.equal(mod.prealertStatusTag("pending").label, "待审核");
  assert.equal(mod.prealertStatusTag("shipped").label, "已发货");
  assert.equal(mod.prealertStatusTag("received").label, "已收货");
  assert.equal(mod.prealertStatusTag("weird").label, "weird", "认不出的原样给，不吞成「已发货」");
  assert.equal(mod.prealertStatusTag(null).label, "—");
  assert.notEqual(mod.prealertStatusTag("approved").color, mod.prealertStatusTag("shipped").color, "已审核跟已发货不同色");
  assert.equal(mod.prealertApprovalZh(undefined, "-"), "-");
  const client = read(CLIENT);
  assert.ok(!/isReceived \? "已收货" : "已发货"/.test(client), "预报单表还是「不是已收货就已发货」");
  assert.equal((client.match(/const \{ label: sLabel, color: sColor, bg: sBg \} = prealertStatusTag\(item\.approvalStatus\);/g) ?? []).length, 2, "首页预报单表、预报单页两张表");
});

check("F03 手机一单一块（三端共用）：件数 0 / null 显示「—」，正数照旧", () => {
  const { mod, requireWeb } = loadTsx("apps/web/src/modules/shipment/ShipmentPhoneList.tsx");
  const { createElement } = requireWeb("react");
  const { renderToStaticMarkup } = requireWeb("react-dom/server");
  const html = (packageCount: number | null) => renderToStaticMarkup(createElement(mod.default, { rows: [{ id: "x", number: "ZZP1", statusText: "待入库", packageCount, packageUnit: "箱", volume: null, weight: null, transport: "—" }], onOpen() {} }));
  for (const n of [0, null]) {
    const h = html(n);
    assert.ok(h.includes("<b>—</b> 箱"), `件数 ${n} 没显示成「—」：${h.match(/ship-phone-metrics.*?<\/span><\/span>/)?.[0]}`);
    assert.ok(!h.includes("<b>0</b>"));
  }
  assert.ok(html(4).includes("<b>4</b> 箱"));
});

check("F03 详情产品表（客户运单查询、客服对话里点运单卡片共用）：产品行件数 0 显示「—」", () => {
  const { mod, requireWeb } = loadTsx("apps/web/src/modules/shipment/ShipmentDetailBody.tsx");
  const { createElement } = requireWeb("react");
  const { renderToStaticMarkup } = requireWeb("react-dom/server");
  const html = renderToStaticMarkup(createElement(mod.default, { item: { products: [{ itemName: "灯具", packageCount: 0 }, { itemName: "鞋", packageCount: 3 }] }, images: [], onPreview() {} }));
  const cells = [...html.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((m) => m[1]);
  const lamp = cells.indexOf("灯具"); const shoe = cells.indexOf("鞋");
  assert.ok(lamp >= 0 && shoe >= 0, `产品行没画出来：${cells.join("|")}`);
  assert.equal(cells[lamp + 1], "—", `件数 0 那格：${cells[lamp + 1]}`);
  assert.equal(cells[shoe + 1], "3");
});

check("F07 打印：件数是空的或 0 不开打印窗口、返回原因；员工 / 超管拿到原因就 setToast", () => {
  let opened = 0;
  const { mod } = loadTsx("apps/web/src/modules/shipment/ShipmentPrintLabel.tsx", { window: { open: () => { opened++; return null; } } });
  for (const props of [
    { marks: "M", trackingNo: "T1", packageCount: 0 },
    { marks: "M", trackingNo: "T1", packageCount: "—" },
    { marks: "M", trackingNo: "T1", packageCount: 0, products: [{ itemName: "灯具", packageCount: 0 }] },
  ]) {
    assert.match(String(mod.printLabelBlockedReason(props)), /件数是空的或 0，排不出箱号/);
    assert.match(String(mod.openPrintLabel(props)), /排不出箱号/);
  }
  assert.equal(opened, 0, "件数没填还开了打印窗口");
  assert.equal(mod.printLabelBlockedReason({ packageCount: 3 }), null);
  assert.equal(mod.printLabelBlockedReason({ packageCount: 0, products: [{ itemName: "鞋", packageCount: 2 }] }), null);
  assert.ok(!/Number\(props\.packageCount\) \|\| 1/.test(read("apps/web/src/modules/shipment/ShipmentPrintLabel.tsx")), "还留着「没件数按 1 箱」的兜底");
  for (const [file, v] of [[STAFF, "item"], [ADMIN, "o"]] as const) {
    assert.match(read(file), new RegExp(`const blocked = openPrintLabel\\(\\{[^\\n]*\\n\\s*//[^\\n]*\\n\\s*if \\(blocked\\) setToast\\(${v}\\.currentStatus === "pendingInbound"`), `${file} 拿到原因没提示`);
  }
});

check("多款待入库：品名没齐、没有产品明细时不许把合并品名打成每一箱的标签", () => {
  let opened = 0;
  const { mod } = loadTsx("apps/web/src/modules/shipment/ShipmentPrintLabel.tsx", { window: { open: () => { opened++; return null; } } });
  const props = { marks: "ZZ", trackingNo: "ZZLABEL", packageCount: 20, itemName: "灯具 / 包", currentStatus: "pendingInbound", products: [] };
  assert.match(mod.openPrintLabel(props), /产品明细.*到货通知/);
  assert.equal(opened, 0);
  assert.equal(mod.printLabelBlockedReason({ ...props, currentStatus: "inWarehouseCN" }), null, "正式老单的无产品行打印不受影响");
  assert.equal(mod.printLabelBlockedReason({ ...props, products: [{ itemName: "灯具", packageCount: 20 }] }), null, "完整待入库行仍能打印");
  for (const [file, v] of [[STAFF, "item"], [ADMIN, "o"]] as const) {
    assert.match(read(file), new RegExp(`openPrintLabel\\(\\{[^\\n]*currentStatus: ${v}\\.currentStatus`), "两端都须传状态");
  }
});

check("F10 物流轨迹弹窗 / 客服选运单：品名空串显示「—」/「（没填品名）」，件数只拼正数", () => {
  const src = read("apps/web/src/modules/shipment/ShipmentTrackModal.tsx");
  assert.ok(!/itemName \?\? "—"/.test(src), "还在用 `?? \"—\"`，挡不住空串");
  assert.match(src, /品名：\{data\.itemName \|\| "—"\}/);
  const picker = read("apps/web/src/modules/cs-chat/ChatRefPicker.tsx");
  assert.match(picker, /\{o\.title \|\| "（没填品名）"\}/);
  assert.match(picker, /typeof o\.packageCount === "number" && o\.packageCount > 0 \?/);
});

check("F08 超管编辑：待入库的货进不了编辑框（电脑 / 手机都走 startEditOrder）；员工页超管也不出「保存订单信息」", () => {
  const admin = read(ADMIN);
  const start = admin.indexOf("const startEditOrder = ");
  assert.ok(start > 0);
  const guard = admin.indexOf('currentStatus === "pendingInbound"', start);
  const open = admin.indexOf("setEditingOrderId(", start);
  assert.ok(guard > 0 && guard < open, "startEditOrder 打开编辑框之前没拦待入库");
  assert.match(admin.slice(guard, open), /setToast\([^)]*到货通知[^)]*\);\s*return;/);
  assert.match(read(STAFF), /item\.canEdit && item\.currentStatus !== "pendingInbound"/);
});

check("G02 超管首页说明文字跟后端新口径一致（今天新建的，或今天在到货通知里转正式的；待入库不算）", () => {
  const src = read("apps/web/src/components/admin/AdminOperationsOverview.tsx");
  assert.ok(!src.includes("收货体积按今日新建的普通父运单统计"), "还是旧口径");
  assert.match(src, /今天在到货通知里转正式的/);
});

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed) process.exit(1);
