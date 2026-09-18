/**
 * 唛头就是账号，客户名字只给内部看（2026-09-18 老板拍板）。
 *
 * 老板原话：「唛头=账号，客户名字是只有我们内部看的」「标着『唛头』还是显示唛头……除了登录页是显示账号，内部其他地方都是显示唛头」。
 * 起因：超管「运单管理」→「详情」里的「唛头」写成了「有名字就显示名字」，XHH6700 显示成了「杨先」——
 * 而「杨先」名下有 3 个账号（XHH6615 / XHH6700 / XT6615），线上 12 个名字对应了 37 个账号，只看名字分不清是哪个唛头。
 * 同一个写法还在「打印标签」（6 月起）、仓库版 / 普通版集货、预报单列表、充值审核、客户余额里。
 *
 * 这份测试盯三件事（读源码，不连库、不起服务）：
 *   ① 改过的地方只许显示唛头（clientId），不许退回「名字优先」；
 *   ② 页面显示唛头的地方，搜索框也要能按唛头搜；
 *   ③ 老板说**保留名字**的两处（员工运单「运单所属用户」、员工运单导出「归属用户」）还是原样 —— 别被人「顺手」改掉。
 * 派送签收单上印什么，由 test-lastmile-export 第 18 项真生成一张来核。
 * 用法：npm run test:mark-display
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string): string => readFileSync(path.join(process.cwd(), p), "utf-8");
let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ ${name}\n     ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}

const adminPage = read("apps/web/src/app/admin/page.tsx");
const staffPage = read("apps/web/src/app/staff/page.tsx");
const adminDetail = read("apps/web/src/components/admin/AdminShipmentDetail.tsx");
const adminWhr = read("apps/web/src/app/admin/whr-consolidation/page.tsx");
const staffWhr = read("apps/web/src/app/staff/whr-consolidation/page.tsx");
const adminCons = read("apps/web/src/app/admin/consolidation/page.tsx");
const staffCons = read("apps/web/src/app/staff/consolidation/page.tsx");
const adminPrealerts = read("apps/web/src/app/admin/prealerts/page.tsx");
const staffPrealerts = read("apps/web/src/components/staff/StaffPrealertList.tsx");
const floorGuard = read("apps/api/src/modules/whr-consolidation/long-term-price.ts");

console.log("唛头显示（唛头=账号，客户名字只给内部看）");

check("1) 超管运单详情里的「唛头」显示账号，不再「有名字就显示名字」", () => {
  assert.match(adminDetail, /\["唛头", display\(order\.clientId\)\]/, "详情「唛头」没用 clientId");
  assert.ok(!/clientName/.test(adminDetail.replace(/\/\/.*$/gm, "")), "详情组件还在用 clientName");
});

check("2) 打印标签上的唛头（超管、员工两处）只印账号", () => {
  for (const [who, src] of [["超管", adminPage], ["员工", staffPage]] as Array<[string, string]>) {
    const marks = [...src.matchAll(/openPrintLabel\(\{ marks: ([^,]+),/g)].map((m) => m[1]);
    assert.ok(marks.length >= 1, `${who}端找不到打印标签`);
    for (const m of marks) assert.ok(!/clientName/.test(m) && /clientId/.test(m), `${who}端标签唛头印的是 ${m}`);
  }
});

check("3) 仓库版集货（超管）：客户卡片、弹窗标题、提示、选客户弹窗都显示唛头", () => {
  for (const bad of ["{c.clientName}", "{priceTarget.clientName}", "{addressTarget.clientName}", "${c.clientName}", "${addressTarget.clientName}", "{cl.name}", "{client?.name ?? sc.clientId}"]) {
    assert.ok(!adminWhr.includes(bad), `超管仓库版集货还在显示名字：${bad}`);
  }
  assert.ok(!/<th[^>]*>客户名<\/th>/.test(adminWhr), "建柜选客户那张表的列头还叫「客户名」");
  assert.ok(!adminWhr.includes('placeholder="按姓名 / 电话 / 公司搜索"'), "建柜搜索框提示没写上能按唛头搜");
  assert.match(adminWhr, /cl\.id\.toLowerCase\(\)\.includes\(q\)/, "选客户弹窗搜不了唛头");
});

check("4) 仓库版集货（员工）：客户卡片、预报单、签收 / 泰国签收 / 审核弹窗、选客户弹窗都显示唛头", () => {
  for (const bad of ["{pa.clientName}", "{signTarget.clientName}", "{thailandTarget.clientName}", "{reviewTarget.prealert.clientName}", "${c.clientName} 名下", "「${c.clientName}」", "{cl.name}"]) {
    assert.ok(!staffWhr.includes(bad), `员工仓库版集货还在显示名字：${bad}`);
  }
  // 页面上的 {c.clientName}（前面不是 $ 的那种）一个都不许有。
  // ⚠️ 导出 Excel 那张表**有意不动**：表头就写着「客户名」、旁边另有一列「唛头」（客户录入的），
  //    跟老板说保留的员工运单导出「归属用户」是同一类，所以 `${c.clientName} 小计` 那行也跟着保留。
  assert.ok(!/(?<!\$)\{c\.clientName\}/.test(staffWhr), "员工仓库版集货页面上还有 {c.clientName}");
  assert.match(staffWhr, /cl\.id\.toLowerCase\(\)\.includes\(q\)/, "选客户弹窗搜不了唛头");
  // 选客户那一行只显示一次唛头（原来是「名字粗体 + 唛头灰字」，只换粗体会变成唛头重复两遍 —— 浏览器实测撞见过）
  assert.ok(!/\{cl\.id\}<\/span>\s*<span[^>]*>\{cl\.id\}<\/span>/.test(staffWhr), "选客户那一行唛头重复显示了两遍");
  // 弹窗对象里要真带着唛头，不然上面换成 clientId 会显示空白
  assert.match(staffWhr, /clientId: pa\.clientId, clientName: pa\.clientName/, "签收弹窗对象里没带唛头");
  assert.match(staffWhr, /setThailandTarget\(\{[^}]*clientId: pa\.clientId/, "泰国签收弹窗对象里没带唛头");
});

check("5) 普通版集货（超管、员工）：列表「客户」列和任务详情显示唛头，搜索能按唛头搜", () => {
  for (const [who, src] of [["超管", adminCons], ["员工", staffCons]] as Array<[string, string]>) {
    assert.ok(!src.includes("{t.clientName"), `${who}普通版集货列表还在显示名字`);
    assert.ok(!src.includes("{taskDetail.clientName}"), `${who}普通版集货详情还在显示名字`);
    assert.match(src, /\(t\.clientId \?\? ""\)\.toLowerCase\(\)\.includes\(s\)/, `${who}普通版集货搜不了唛头`);
  }
});

check("6) 预报单列表（超管「预报单管理」、员工预报单）显示唛头，搜索能按唛头搜", () => {
  for (const [who, src] of [["超管", adminPrealerts], ["员工", staffPrealerts]] as Array<[string, string]>) {
    assert.ok(!/clientName \?\? item\.clientId/.test(src), `${who}预报单列表还是「名字优先」`);
  }
  assert.match(adminPrealerts, /\$\{item\.clientId \?\? ""\}/, "超管预报单搜索搜不了唛头");
  assert.match(staffPage, /\$\{item\.id\} \$\{item\.orderNo \?\? ""\} \$\{item\.clientId \?\? ""\}/, "员工预报单搜索搜不了唛头");
  assert.match(staffPage, /客户：\{approvingPrealert\.clientId \?\? "-"\}/, "员工审核预报单弹窗还在显示名字");
});

check("7) 充值审核（超管）、客户余额（员工）显示唛头", () => {
  assert.ok(!adminPage.includes("{r.clientName}"), "超管充值审核表还在显示名字");
  assert.ok(!adminPage.includes("确认通过 ${r.clientName}"), "超管充值确认框还在显示名字");
  assert.ok(!staffPage.includes("{b.clientName}"), "员工客户余额表还在显示名字");
});

check("8) 仓库版集货「单价不能低于代理价」那句报错点名用唛头", () => {
  assert.match(floorGuard, /const who = entry\.clientId;/, "报错里点名还在用客户名字");
});

check("9) 老板说保留名字的两处原样不动：员工运单「运单所属用户」、员工运单导出「归属用户」", () => {
  assert.match(staffPage, /label="运单所属用户"[\s\S]{0,200}value=\{item\.clientName \?\? item\.clientId \?\? "—"\}/, "「运单所属用户」被改了（老板说这个不换）");
  assert.match(staffPage, /归属用户: item\.clientName \?\? item\.clientId \?\? "-"/, "导出「归属用户」被改了（老板说这个不换）");
});

if (failures > 0) {
  console.log(`❌ 失败 ${failures} 项`);
  process.exit(1);
}
console.log("✅ 唛头显示：9 项全部通过");
