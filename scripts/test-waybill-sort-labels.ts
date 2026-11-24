/**
 * 运单管理按到仓日期排 + 编辑框每个格子写名字（2026-11-23）—— 不连库。
 *
 * 老板：「怎么物流系统的不是按运单的时间来排序的？」→ 给 A 按到仓日期 / B 按录入时间，他选「A 按到仓日期」；
 *       「我编辑的时候为什么看不到长宽高？」→ 格子名只写在灰色提示字里，一填数字就没了。
 *
 * 盯：
 *   S1 排序规则真跑：到仓日期新的在上；同一天晚录入的在上；都一样按运单号数字从大到小；没填 / 填得不像日期的排最后；
 *      没有录入时间的（后端老版本）同一天里排后面、不报错；排两遍结果一样
 *   S2 线上那种情况：东莞 JL20260701-3051（号最长、10 月到仓）不再压在今天到仓的义乌 YW0001912 上面
 *   S3 员工页、管理员页的「运单管理」都用这一个排序；两页里不再有「按运单号数字」那段老排序
 *   S4 员工运单列表接口给录入时间（跟管理员列表同一个口径：订单建单时间），前端类型里有这个字段
 *   S5 编辑框上面那排：每个格子外面都包了名字（数一下格子和名字一样多），名字是这几个、按这个顺序
 *   S6 产品行：列名和所有格子放在同一个网格里（列宽一起算才对得齐）；列名顺序跟格子一一对上（品名 箱数 长 宽 高 …），长宽高在第 3、4、5 格；
 *      每一格显示的、改的、提示字、读屏名字是同一个字段
 *   S7 管理员页排的是那一页「到仓日期」那一列显示的日期（没填退到建单日期、待入库没填排最后）—— dsh 11-23 第 1 轮
 *   S1 补：2026-02-31、2026-99-99 这种不存在的日子当没填（dsh 11-23 第 1 轮）
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { compareWaybillsByArrival, compareTrackingNoDesc, waybillArrivalComparator, type WaybillSortFields } from "../apps/web/src/modules/shipment/waybill-sort";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`❌ ${name}`);
    console.log(`   ${(e as Error).message.split("\n").join("\n   ")}`);
  }
}

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`❌ ${name}`);
    console.log(`   ${(e as Error).message.split("\n").join("\n   ")}`);
  }
}

const sorted = (rows: Array<WaybillSortFields & { id: string }>) => [...rows].sort(compareWaybillsByArrival).map((r) => r.id);

check("S1 到仓日期新的在上；同一天晚录入的在上；再一样按运单号；没填 / 不像日期的排最后；没录入时间的排同一天后面", () => {
  const rows = [
    { id: "old", shipDate: "2026-10-05", createdAt: "2026-10-05T03:00:00.000Z", trackingNo: "YW0001500" },
    { id: "today-early", shipDate: "2026-11-23", createdAt: "2026-11-23T01:00:00.000Z", trackingNo: "SZ261102168" },
    { id: "today-late", shipDate: "2026-11-23", createdAt: "2026-11-23T04:00:00.000Z", trackingNo: "YW0001912" },
    { id: "nodate", shipDate: null, createdAt: "2026-11-23T05:00:00.000Z", trackingNo: "YW0009999" },
    { id: "baddate", shipDate: "23/11/2026", createdAt: "2026-11-23T05:00:00.000Z", trackingNo: "YW0009998" },
    { id: "yesterday", shipDate: "2026-11-22", createdAt: "2026-11-22T10:00:00.000Z", trackingNo: "GZ261102215" },
    { id: "today-nocreated", shipDate: "2026-11-23", trackingNo: "YW0001999" },
    { id: "twinA", shipDate: "2026-11-20", createdAt: "2026-11-20T02:00:00.000Z", trackingNo: "YW0001800" },
    { id: "twinB", shipDate: "2026-11-20", createdAt: "2026-11-20T02:00:00.000Z", trackingNo: "YW0001801" },
    { id: "spaced", shipDate: " 2026-11-21 ", createdAt: "2026-11-21T02:00:00.000Z", trackingNo: "YW0001700" },
    { id: "feb31", shipDate: "2026-02-31", createdAt: "2026-11-23T05:00:00.000Z", trackingNo: "YW0009997" },
    { id: "month99", shipDate: "2026-99-99", createdAt: "2026-11-23T05:00:00.000Z", trackingNo: "YW0009996" },
    { id: "leap", shipDate: "2024-02-29", createdAt: "2024-02-29T05:00:00.000Z", trackingNo: "YW0000001" },
  ];
  const want = ["today-late", "today-early", "today-nocreated", "yesterday", "spaced", "twinB", "twinA", "old", "leap", "nodate", "baddate", "feb31", "month99"];
  assert.deepEqual(sorted(rows), want);
  // 打乱了再排一遍，结果一样（顺序不靠接口原来给的先后）
  assert.deepEqual(sorted([...rows].reverse()), want);
  // 比较函数里按行记住了算好的日子（11-23 提速）：同一个对象改了日期 / 录入时间再排，要跟着变，不能用记住的旧值
  const live = rows.map((r) => ({ ...r }));
  live.sort(compareWaybillsByArrival);
  const oldOne = live.find((r) => r.id === "old")!;
  oldOne.shipDate = "2026-11-24";
  assert.equal([...live].sort(compareWaybillsByArrival)[0].id, "old", "改了到仓日期再排还在原地：用了记住的旧日子");
  const early = live.find((r) => r.id === "today-early")!;
  early.createdAt = "2026-11-23T09:00:00.000Z";
  assert.deepEqual([...live].sort(compareWaybillsByArrival).slice(0, 3).map((r) => r.id), ["old", "today-early", "today-late"], "改了录入时间再排没跟着变");
  // 没填和填错的两张：按运单号兜底（9999 > 9998），顺序固定
  assert.ok(compareWaybillsByArrival(rows[3], rows[4]) < 0);
  // 运单号兜底照原来的规矩：先比位数、再比数字，不用 Number()（超 15 位丢精度）
  assert.ok(compareTrackingNoDesc("YW0001220", "YW0001219") < 0);
  assert.ok(compareTrackingNoDesc("A1234567890123456789", "A1234567890123456788") < 0);
  assert.equal(compareTrackingNoDesc("SZ1", "SZ1"), 0);
  assert.notEqual(compareTrackingNoDesc("SZ261102334", "GZ261102334"), 0, "数字一样只差前缀：也要分出先后，每次刷新不跳");
});

check("S2 线上那种情况：号最长的东莞老单不再压在今天的义乌单上面", () => {
  const rows = [
    { id: "JL20260701-3051", shipDate: "2026-10-26", createdAt: "2026-11-17T02:00:00.000Z", trackingNo: "JL20260701-3051" },
    { id: "SZ261102334", shipDate: "2026-11-22", createdAt: "2026-11-22T14:56:00.000Z", trackingNo: "SZ261102334" },
    { id: "YW0001912", shipDate: "2026-11-23", createdAt: "2026-11-22T19:55:00.000Z", trackingNo: "YW0001912" },
  ];
  assert.deepEqual(sorted(rows), ["YW0001912", "SZ261102334", "JL20260701-3051"]);
});

check("S3 员工页、管理员页的运单管理都用这一个排序，老的「按运单号数字」排序没了", () => {
  const staff = read("apps/web/src/app/staff/page.tsx");
  const admin = read("apps/web/src/app/admin/page.tsx");
  assert.match(staff, /import \{ compareWaybillsByArrival \} from "\.\.\/\.\.\/modules\/shipment\/waybill-sort";/);
  assert.match(admin, /import \{ waybillArrivalComparator \} from "\.\.\/\.\.\/modules\/shipment\/waybill-sort";/);
  // 管理员页排的是它那一列显示的日期（adminArrivedDate），员工页那一列只显示 shipDate
  assert.match(admin, /\nconst compareAdminWaybillsByArrival = waybillArrivalComparator\(adminArrivedDate\);\n/);
  assert.equal((staff.match(/\.sort\(compareWaybillsByArrival\)/g) ?? []).length, 1);
  assert.equal((admin.match(/\.sort\(compareAdminWaybillsByArrival\)/g) ?? []).length, 1);
  for (const [rel, src] of [["staff", staff], ["admin", admin]] as const) {
    assert.doesNotMatch(src, /trackingNo \?\? ""\)\.replace\(\/\\D\/g, ""\)\.replace\(\/\^0\+\/, ""\)/, `${rel} 还留着按运单号数字的老排序`);
  }
  // 员工页那一列显示的就是 shipDate（arrivedAt 后端也给的 shipDate）—— 跟员工页排序同一个日期
  assert.match(staff, /\{item\.shipDate \?\? formatDateTime\(item\.arrivedAt\)\}/);
  assert.match(read("apps/api/src/modules/shipments/routes.ts"), /arrivedAt: r\.order\?\.shipDate \?\? undefined,/);
  // 管理员页那一列（电脑、手机、详情）都显示 adminArrivedDate
  assert.match(admin, /\{adminArrivedDate\(o\) \|\| "—"\}/);
  assert.match(admin, /到仓 \$\{adminArrivedDate\(o\) \|\| "—"\}/);
  // 员工页排完那份才给列表；管理员页排完才 setOrderList
  assert.match(staff, /shipmentItems\.sort\(compareWaybillsByArrival\);[\s\S]{0,600}setShipments\(shipmentItems\.filter/);
  assert.match(admin, /list\.sort\(compareAdminWaybillsByArrival\);\s*setOrderList\(list\);/);
});

check("S4 员工运单列表接口给录入时间（订单建单时间，没有订单才用运单的），前端类型有这个字段", () => {
  const api = read("apps/api/src/modules/shipments/routes.ts");
  const start = api.indexOf('app.get("/staff/shipments"');
  assert.ok(start > 0);
  const block = api.slice(start, start + 12000);
  assert.match(block, /createdAt: \(r\.order\?\.createdAt \?\? r\.createdAt\)\.toISOString\(\),/);
  // 管理员列表同一个口径
  assert.match(read("apps/api/src/modules/admin/routes.ts"), /createdAt: r\.order\?\.createdAt\.toISOString\(\) \?\? r\.createdAt\.toISOString\(\),/);
  const types = read("apps/web/src/services/business-api.ts");
  const iStart = types.indexOf("export interface ShipmentItem {");
  const iEnd = types.indexOf("\n}\n", iStart);
  assert.match(types.slice(iStart, iEnd), /\n  createdAt\?: string;\n/);
});

const dialog = read("apps/web/src/modules/orders/WaybillEditDialog.tsx");

check("S5 编辑框上面那排：每个格子都有名字，名字是这几个、按这个顺序", () => {
  const start = dialog.indexOf('gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))"');
  const end = dialog.indexOf("{/* 换成封禁的唛头时的提示", start);
  assert.ok(start > 0 && end > start);
  const block = dialog.slice(start, end);
  const controls = block.match(/<(MarkPicker|input|select)\b/g) ?? [];
  const captions = [...block.matchAll(/<Named caption="([^"]+)">/g)].map((m) => m[1]);
  assert.equal(controls.length, 13); // 2026-11-24 加了整票「货型」
  assert.equal(captions.length, controls.length, "有格子没包名字");
  assert.deepEqual(captions, ["唛头", "运单号", "柜号", "仓库", "运输方式", "货型", "国内单号", "收货地址", "装柜号", "包装", "总重量(kg)", "总体积(m³)", "到仓日期"]);
  // 每个名字包住的正好是一个格子，而且是对的那个字段（名字写「运单号」包的却是柜号那格，测得出来）
  const fieldOf: Record<string, string> = {
    clientId: "唛头", trackingNo: "运单号", batchNo: "柜号", warehouseId: "仓库", transportMode: "运输方式", cargoType: "货型",
    domesticTrackingNo: "国内单号", receiverAddressTh: "收货地址", containerNo: "装柜号", packageUnit: "包装",
    weightKg: "总重量(kg)", volumeM3: "总体积(m³)", shipDate: "到仓日期",
  };
  for (const m of block.matchAll(/<Named caption="([^"]+)">([\s\S]*?)<\/Named>/g)) {
    assert.equal((m[2].match(/<(MarkPicker|input|select)\b/g) ?? []).length, 1, m[0].slice(0, 80));
    const key = /value=\{form\.([a-zA-Z0-9]+)\}/.exec(m[2])?.[1] ?? "";
    assert.equal(fieldOf[key], m[1], `「${m[1]}」包的是 form.${key}`);
    assert.match(m[2], new RegExp(`\\.\\.\\.(?:v|f), ${key}:`), `「${m[1]}」改的不是 ${key}`);
  }
  // 读屏名字：原生格子各自写 aria-label，跟显示的名字一字不差；唛头那格是组件，靠自己的提示字「唛头」
  for (const m of block.matchAll(/<Named caption="([^"]+)"><(input|select) ([^\n]*)/g)) {
    assert.match(m[3], new RegExp(`^aria-label="${m[1].replace(/[()]/g, "\\$&")}" `), `「${m[1]}」那格读屏名字不对`);
  }
  assert.equal([...block.matchAll(/<Named caption="[^"]+"><(input|select) aria-label=/g)].length, 12);
  assert.match(block, /<Named caption="唛头"><MarkPicker [^\n]*placeholder="唛头"/);
  // 名字常驻：画在格子外面，不靠 placeholder
  assert.match(dialog, /function Named\(props: \{ caption: string; children: ReactNode \}\) \{[\s\S]{0,200}<span style=\{fieldName\}>\{props\.caption\}<\/span>\s*\{props\.children\}/);
});

check("S6 产品行：列名和所有格子在同一个网格里（列宽一起算才对得齐）；列名跟格子一一对上，长宽高在第 3、4、5 格", () => {
  const names = /const PRODUCT_COLUMN_NAMES = \[([^\]]+)\] as const;/.exec(dialog);
  assert.ok(names);
  const cols = [...names![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const gridStart = dialog.indexOf("{products.length > 0 && (");
  const gridEnd = dialog.indexOf("+ 添加产品", gridStart);
  assert.ok(gridStart > 0 && gridEnd > gridStart);
  const grid = dialog.slice(gridStart, gridEnd);
  // 同一个网格：列名、每一行的格子都是这一个 div 的直接孩子（行用 Fragment，不再各套一个 div 各算列宽 —— 11-23 实看对不齐）
  assert.match(grid, /^\{products\.length > 0 && \(\s*<div style=\{\{ display: "grid", gridTemplateColumns: productGrid,/);
  assert.match(grid, /PRODUCT_COLUMN_NAMES\.map\(\(name\) => <span key=\{`col-\$\{name\}`\} aria-hidden="true"/);
  assert.match(grid, /<span key="col-remove" aria-hidden="true" \/>\s*\{products\.map\(\(p, i\) => \(\s*<Fragment key=\{`row-\$\{i\}`\}>/);
  assert.doesNotMatch(grid, /products\.map\(\(p, i\) => \(\s*<div/, "产品行又各套了一个 div：列宽各算各的，列名会对不齐");
  assert.equal((dialog.match(/gridTemplateColumns: productGrid/g) ?? []).length, 1, "只该有一个产品网格");
  const keys = [...grid.matchAll(/setProduct\(i, "([a-zA-Z]+)"/g)].map((m) => m[1]);
  const zh: Record<string, string> = {
    itemName: "品名", packageCount: "箱数", lengthCm: "长cm", widthCm: "宽cm", heightCm: "高cm",
    productQuantity: "单箱数量", weightKg: "单箱重kg", cargoType: "货型", domesticTrackingNo: "国内单号",
  };
  assert.deepEqual(keys.map((k) => zh[k] ?? `没对上:${k}`), cols);
  assert.deepEqual(cols.slice(2, 5), ["长cm", "宽cm", "高cm"]);
  // 每一格：显示的值、改的字段、读屏名字是同一个；数字格的提示字也一样（dsh：长宽的 value 对调了，只看 setProduct 顺序测不出来）
  const row = grid.slice(grid.indexOf("<Fragment"), grid.indexOf("</Fragment>"));
  // 一格一行（属性里有箭头函数的「>」，不能按「>」切）
  const cells = row.split("\n").map((l) => l.trim()).filter((l) => /^<(input|select)\b/.test(l));
  assert.equal(cells.length, cols.length);
  cells.forEach((attrs, idx) => {
    const setKey = /setProduct\(i, "([a-zA-Z]+)"/.exec(attrs)?.[1] ?? "";
    const valueKey = /value=\{\(?p\.([a-zA-Z]+)/.exec(attrs)?.[1] ?? "";
    const aria = /aria-label=\{`第\$\{i \+ 1\}行 ([^`]+)`\}/.exec(attrs)?.[1] ?? "";
    assert.equal(valueKey, setKey, `第 ${idx + 1} 格显示 p.${valueKey}、改的却是 ${setKey}`);
    assert.equal(zh[setKey], cols[idx], `第 ${idx + 1} 格`);
    assert.equal(aria, cols[idx], `第 ${idx + 1} 格读屏名字`);
    const ph = /placeholder="([^"]+)"/.exec(attrs)?.[1];
    if (/type="number"/.test(attrs)) assert.equal(ph, cols[idx], `第 ${idx + 1} 格提示字`);
  });
  // 每行格子数 = 列名数 + 最后的 X 按钮，跟网格列数一样
  const rowCells = (grid.slice(grid.indexOf("<Fragment"), grid.indexOf("</Fragment>")).match(/<(input|select|button)\b/g) ?? []).length;
  const colCount = /const productGrid = "([^"]+)";/.exec(dialog)![1].trim().split(/\s+/).length;
  assert.equal(rowCells, cols.length + 1);
  assert.equal(colCount, cols.length + 1);
});

void (async () => {
  await checkAsync("S7 管理员页排的是那一列显示的日期：没填到仓日期的按建单日期（北京）排进那一天，待入库没填的排最后；不存在的日子照原样显示、按没填排", async () => {
    // 路径放变量里动态取：export-filter 引了 .tsx（ShipmentTableGrid），测试脚本那份 tsconfig 没开 jsx，
    // 写死字面量 tsc 会去解析它报错（dsh 11-23 第 2 轮；同 test-review-1018-source S10 的做法）
    const filterPath = "../apps/web/src/modules/shipment/export-filter";
    const { adminArrivedDate } = (await import(filterPath)) as { adminArrivedDate: (row: { shipDate?: string | null; createdAt?: string | null; currentStatus?: string | null }) => string };
    const cmp = waybillArrivalComparator(adminArrivedDate);
    const rows = [
      { id: "a1123", shipDate: "2026-11-23", createdAt: "2026-11-22T19:55:00.000Z", trackingNo: "YW0001912", currentStatus: "inWarehouse" },
      { id: "noShip-1123", shipDate: null, createdAt: "2026-11-22T20:30:00.000Z", trackingNo: "111", currentStatus: "loaded" },
      { id: "a1122", shipDate: "2026-11-22", createdAt: "2026-11-22T10:00:00.000Z", trackingNo: "GZ261102215", currentStatus: "inWarehouse" },
      { id: "pending-noShip", shipDate: null, createdAt: "2026-11-23T01:00:00.000Z", trackingNo: "YW0001999", currentStatus: "pendingInbound" },
    ];
    // 管理员页那一列显示的：11-23 / 11-23（建单日期，北京）/ 11-22 / 「—」
    assert.deepEqual(rows.map((r) => adminArrivedDate(r)), ["2026-11-23", "2026-11-23", "2026-11-22", ""]);
    assert.deepEqual([...rows].sort(cmp).map((r) => r.id), ["noShip-1123", "a1123", "a1122", "pending-noShip"]);
    // 员工页同样四张：那一列只显示 shipDate，没填的两张都排最后（两张都显示「—」，按录入时间晚的在上）
    assert.deepEqual([...rows].sort(compareWaybillsByArrival).map((r) => r.id), ["a1123", "a1122", "pending-noShip", "noShip-1123"]);
    // 不存在的日子（线上 11-23 一张都没有）：那一列照原样显示，留给人去改；排序当没填排最后（文件头写明）
    const feb31 = { id: "feb31", shipDate: "2026-02-31", createdAt: "2026-11-23T05:00:00.000Z", trackingNo: "YW0000002", currentStatus: "inWarehouse" };
    assert.equal(adminArrivedDate(feb31), "2026-02-31");
    assert.deepEqual([...rows, feb31].sort(cmp).map((r) => r.id), ["noShip-1123", "a1123", "a1122", "feb31", "pending-noShip"]);
    // ↑ feb31 跟「—」那张都算没填，按录入时间晚的在上
    // 同一个对象原地从待入库改成已装柜再排（管理员页那一列从「—」变成建单日期）：要跟着变（比较函数按行记住了算好的日子，dsh 第 5 轮）
    const live = rows.map((r) => ({ ...r }));
    live.sort(cmp);
    assert.equal(live[live.length - 1].id, "pending-noShip");
    live.find((r) => r.id === "pending-noShip")!.currentStatus = "loaded";
    assert.deepEqual([...live].sort(cmp).map((r) => r.id), ["pending-noShip", "noShip-1123", "a1123", "a1122"], "改了状态再排没跟着变");
  });

  console.log(failed ? `\n❌ 失败 ${failed} 项（通过 ${passed}）` : `\n✅ 运单排序 + 编辑框格子名字：${passed} 项全部通过`);
  if (failed) process.exit(1);
})();
