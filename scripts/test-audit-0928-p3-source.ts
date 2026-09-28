/**
 * 2026-09-28 审查报告那批小 bug —— 读源码的回归（不连库、不起浏览器），管页面上的几处。
 * 后端那几条在 test-audit-0928-p3-db.ts 里真跑 handler。
 * 每条都是「把修复改回去这条就红」的钉子；改法变了要跟着改，别为了绿把断言放宽。
 *
 *   C  已收货的预报单：员工端、管理员端都不再给「修改 / 编辑」「确认收货」按钮
 *   D  装柜页「删除柜子」只给超管（接口只许 admin）
 *   E  整柜三页顶上标题登记了中文
 *   L  客户批量导入：仓库带不带「仓」字都认；认不出 / 没填的行标红、不让提交，不悄悄丢掉
 *   M  客户建预报单没有「预报单号（留空自动生成）」那一格（后端从来不用它）
 *   R  客户集货详情没有凭空的「装柜时间」（员工只填日期）
 *   A  运费配置保存失败时把后台说的原因带出来
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vm from "node:vm";
import ts from "typescript";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
let passed = 0, failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
}

check("C 员工端预报单列表：已收货的单只显示「已收货」，「修改」「确认收货」按钮在 received 判断的另一支里", () => {
  const src = read("apps/web/src/components/staff/StaffPrealertList.tsx");
  const i = src.indexOf('item.approvalStatus === "received" ?');
  assert.ok(i > 0, "没有按「已收货」分开");
  const tail = src.slice(i);
  const yes = tail.slice(0, tail.indexOf(") : ("));
  assert.match(yes, /已收货/);
  assert.ok(!/确认收货|onApprovePrealert/.test(yes), "已收货那一支里还有确认收货按钮");
  const no = tail.slice(tail.indexOf(") : ("), tail.indexOf("</div>\n                  )}"));
  assert.match(no, /onApprovePrealert/, "没收货的那一支里确认收货按钮不见了");
});

check("C 管理员端预报单页：已收货的单只显示「已收货」，编辑 / 确认收货放在后面两支", () => {
  const src = read("apps/web/src/app/admin/prealerts/page.tsx");
  const m = /\{item\.approvalStatus === "received" \? \(\s*<span[^>]*>已收货<\/span>\s*\) : isEditing \?/.exec(src);
  assert.ok(m, "管理员端没有按「已收货」先分开（应当是 received ? 已收货 : isEditing ? …）");
});

check("D 装柜页「删除柜子」按钮要 isAdmin，而且 isAdmin 从登录信息的 role === \"admin\" 来", () => {
  const src = read("apps/web/src/app/staff/container-loading/page.tsx");
  assert.match(src, /\{isAdmin && detail\.status === "LOADING" && !detail\.isFcl && \(\s*<button onClick=\{handleDelete\}/, "删除柜子按钮没挡员工");
  assert.match(src, /setIsAdmin\(getOptionalSession\(\)\?\.role === "admin"\)/);
  assert.match(src, /import \{ getOptionalSession \} from "\.\.\/\.\.\/\.\.\/auth\/auth-session"/);
});

check("E 整柜三页的顶上标题登记了中文", () => {
  const src = read("apps/web/src/modules/layout/WorkbenchFrame.tsx");
  for (const [p, t] of [["/admin/fcl-containers", "整柜管理"], ["/staff/fcl-containers", "整柜管理"], ["/client/fcl-containers", "我的整柜"]]) {
    assert.ok(src.includes(`"${p}": "${t}"`), `${p} 没登记标题`);
  }
});

check("L 客户批量导入认仓库：义乌 / 义乌仓 / wh_yiwu_01 都认成 wh_yiwu_01；乱写的认不出", () => {
  const src = read("apps/web/src/app/client/imports/page.tsx");
  const start = src.indexOf("const WAREHOUSE_ZH");
  const end = src.indexOf("function downloadTemplate");
  assert.ok(start > 0 && end > start, "没找到仓库对照表");
  const js = ts.transpileModule(src.slice(start, end) + "\nmodule.exports = { WAREHOUSE_BY_NAME, WAREHOUSE_ZH };", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const sandbox: any = { module: { exports: {} } };
  vm.runInNewContext(js, sandbox);
  const { WAREHOUSE_BY_NAME } = sandbox.module.exports;
  for (const [raw, id] of [["义乌", "wh_yiwu_01"], ["义乌仓", "wh_yiwu_01"], ["wh_yiwu_01", "wh_yiwu_01"], ["广州", "wh_guangzhou_01"], ["东莞仓", "wh_dongguan_01"], ["深圳", "wh_shenzhen_01"]]) {
    assert.equal(WAREHOUSE_BY_NAME[raw], id, `「${raw}」认成了 ${WAREHOUSE_BY_NAME[raw]}`);
  }
  for (const raw of ["杭州仓", "wh_test", "", "constructor"]) {
    assert.ok(!Object.prototype.hasOwnProperty.call(WAREHOUSE_BY_NAME, raw), `「${raw}」不该认得出来`);
  }
  // 解析时查这张表，认不出来是 null（不是把原文当 id）
  // 解析时查这张表只认表里自己的键（constructor / toString / __proto__ 这种写法原来会从对象原型上查出东西来）
  assert.match(src, /const warehouseKey = rawWarehouse\.replace\(\/\\s\+\/g, ""\);\s*const warehouseId = Object\.prototype\.hasOwnProperty\.call\(WAREHOUSE_BY_NAME, warehouseKey\) \? WAREHOUSE_BY_NAME\[warehouseKey\] : null;/);
});

check("L 客户批量导入：仓库没填 / 认不出来的行不丢，标红，提交按钮拦住", () => {
  const src = read("apps/web/src/app/client/imports/page.tsx");
  const at = src.indexOf("function normalizeRows(");
  assert.ok(at > 0, "没找到解析函数 normalizeRows");
  const filter = /\.filter\(\(item\) => ([^;]+)\);/.exec(src.slice(at));
  assert.ok(filter, "没找到解析后的过滤");
  assert.ok(!/warehouseId/.test(filter![1]), `过滤条件还在按仓库丢行：${filter![1]}`);
  assert.match(src, /entry\.row\.cargoType === null \|\| entry\.row\.warehouseId === null/, "提交前没拦仓库认不出来的行");
  assert.match(src, /disabled=\{loading \|\| parsing \|\| rows\.length === 0 \|\| badCargoRows\.length > 0\}/);
  assert.match(src, /row\.warehouseId === null\s*\? \(row\.warehouseRaw \? `「\$\{row\.warehouseRaw\}」认不出来` : "没填"\)/, "预览里没把认不出来的仓库标出来");
  // 标红的行不能再算成「有效」（原来的提示「已读取 3 条有效数据」+ 提交按钮却是灰的，客户看不懂）
  assert.match(src, /const validCount = useMemo\(\(\) => rows\.filter\(\(r\) => r\.cargoType !== null && r\.warehouseId !== null && r\.transportMode !== null\)\.length/, "「当前有效行」把标红的也算进去了");
  assert.match(src, /其中 \$\{badCount\} 条标红的要改/, "读完文件的提示没说有几条要改");
});

check("M 客户建预报单没有「预报单号（留空自动生成）」输入框", () => {
  const src = read("apps/web/src/app/client/page.tsx");
  assert.ok(!/<span>预报单号（留空自动生成）<\/span>/.test(src), "那一格还在（后端从来不用客户填的号）");
  assert.ok(!/setForm\(\(v\) => \(\{ \.\.\.v, trackingNo: e\.target\.value \}\)\)/.test(src), "还有地方让客户填 trackingNo");
});

check("R 客户集货详情不再把「装柜日期」格式化成「装柜时间」", () => {
  const src = read("apps/web/src/app/client/consolidation/page.tsx");
  assert.ok(!/formatBeijingTime\(taskDetail\.loadingDate\)/.test(src), "还在把只有日期的装柜日期按钟点显示");
  assert.match(src, />装柜日期</, "「装柜日期」那格被一起删了");
});

check("A 运费配置保存失败：提示里带后台的原因", () => {
  const src = read("apps/web/src/components/admin/ShippingConfig.tsx");
  assert.match(src, /props\.onToast\(`保存失败：\$\{e instanceof Error \? e\.message : "请重试"\}`\)/);
});

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) process.exit(1);
