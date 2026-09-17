/**
 * 返现单页面：撤回「已返」这一套在界面上真的接通了（2026-09-18 老板拍板「能撤回，但要看得到记录」）。
 *
 * 为什么要这么测：这一块的界面只有超管在用，本机连不上测试库时点不开页面（CLAUDE.md #22、#32 的教训：
 * 「接口通了」不等于「页面上有」，`tsc` 全绿也照不到「按钮根本没渲染」「函数没人调」）。
 * 所以这里直接读页面源码卡住几件事：撤回按钮在、原因必填、点了会调撤回接口、操作记录会渲染、
 * 确认框里那句「不能撤回」已经删掉。
 *
 * 不连数据库、不起服务。用法：npm run test:rebate-undo-page
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const panelFile = path.join(process.cwd(), "apps/web/src/components/admin/agents/AgentRebatesPanel.tsx");
const serviceFile = path.join(process.cwd(), "apps/web/src/services/agents-admin-api.ts");
const panel = readFileSync(panelFile, "utf-8");
const service = readFileSync(serviceFile, "utf-8");

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

console.log("返现单「撤回已返」页面接线");

check("1) 前端有撤回接口，打的是 undo-paid，带 id 和 reason", () => {
  assert.match(service, /export async function undoAgentRebatePaid\(id: string, reason: string\)/, "缺 undoAgentRebatePaid");
  const fn = service.slice(service.indexOf("export async function undoAgentRebatePaid"));
  assert.match(fn.slice(0, 500), /\/admin\/agents\/rebates\/undo-paid/, "打错接口");
  assert.match(fn.slice(0, 500), /JSON\.stringify\(\{ id, reason \}\)/, "没把原因发上去");
  assert.match(service, /history: AgentRebateHistoryItem\[\]/, "明细返回值里没声明 history，页面就读不到流水");
});

check("2) 页面真的调了撤回接口（不是只 import 不用）", () => {
  assert.ok(panel.includes("undoAgentRebatePaid"), "页面没 import 撤回接口");
  assert.ok(/await undoAgentRebatePaid\(/.test(panel), "import 了却没调用（等于死代码）");
});

check("3) 已返的单上有「撤回」按钮，未返的单上是「已返」按钮", () => {
  assert.match(panel, /s\.status === "unpaid" \?[\s\S]{0,400}markPaid\(s\)[\s\S]{0,400}setUndoing\(s\)/, "列表行没有按状态分出两个按钮");
  assert.ok(panel.includes(">撤回<"), "列表里没有「撤回」按钮");
  assert.ok(panel.includes("撤回「已返」"), "明细弹窗里没有撤回入口");
});

check("4) 撤回要写原因：没写不许点，前端也自己挡一道", () => {
  assert.match(panel, /disabled=\{paying === undoing\.id \|\| undoReason\.trim\(\) === ""\}/, "原因空着时「确认撤回」没置灰");
  assert.match(panel, /if \(!reason\) \{[\s\S]{0,200}setError\("撤回要写一句原因/, "前端没挡空原因");
  assert.match(panel, /maxLength=\{200\}/, "原因没限长（后端是 200）");
});

check("5) 撤回成功后刷新列表和已经打开的明细（不然还显示已返）", () => {
  const start = panel.indexOf("const undoPaid = async");
  assert.ok(start > 0, "找不到 undoPaid");
  const body = panel.slice(start, panel.indexOf("\n  return (", start));
  assert.ok(body.includes("await load()"), "撤回后没刷新列表");
  assert.match(body, /if \(detail\?\.statement\.id === s\.id\) setDetail\(await fetchAgentRebateDetail\(s\.id\)\)/, "撤回后没刷新打开着的明细");
  assert.match(body, /catch \(e\) \{[\s\S]{0,200}setError\(`撤回失败/, "撤回失败没给红字");
});

check("6) 明细弹窗里渲染操作记录（时间 / 操作 / 操作人 / 原因）", () => {
  assert.ok(panel.includes("操作记录"), "没有「操作记录」这一块");
  assert.match(panel, /detail\.history\.map\(/, "history 没被渲染（只拿不显示等于没有）");
  for (const col of ["时间", "操作", "操作人", "金额", "原因"]) {
    assert.ok(panel.includes(`"${col}"`), `操作记录少了「${col}」这一列`);
  }
  assert.ok(panel.includes("撤回已返"), "操作记录里没有「撤回已返」这个标签");
  assert.match(panel, /detail\.history\.length === 0 \?/, "没有「还没人点过已返」的空状态");
});

check("7) 点「已返」的确认框不再写「不能撤回」", () => {
  assert.ok(!panel.includes("不能撤回"), "确认框还写着「不能撤回」，跟现在的功能对不上");
  assert.ok(panel.includes("点错了可以撤回"), "确认框没告诉员工可以撤回");
});

console.log(failures === 0 ? "✅ 全部通过" : `❌ 失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
