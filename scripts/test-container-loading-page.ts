/**
 * 装柜管理页面：操作失败时红字报错不能被刷新冲掉（2026-09-17，Opus 第 6 轮复核 B 报的）。
 *
 * 页面里 loadList / loadDetail / loadShipmentList 一进门就 setError("")（清掉上一次的报错）。
 * 撤销、删除这两个 handler 失败时「先 setError 再刷新」，结果报错一闪就没了 ——
 * 员工点了撤销没反应、也不知道为什么（后端这时候会说「刚刚被别人改过，请刷新后再看」这种要紧的话）。
 * 所以这两处必须**先刷新、最后 setError**。
 *
 * 不连数据库、不起服务，直接读页面源码卡住写法。用法：npm run test:container-page
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const file = path.join(process.cwd(), "apps/web/src/app/staff/container-loading/page.tsx");
const source = readFileSync(file, "utf-8");

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

/** 取某个 handler 里 catch 块的代码 */
function catchBlockOf(handler: string): string {
  const start = source.indexOf(`const ${handler} = async`);
  assert.ok(start >= 0, `找不到 ${handler}`);
  const next = source.indexOf("\n  const ", start + 10);
  const body = source.slice(start, next > 0 ? next : source.length);
  // 取最后一个 catch：撤销那个 handler 前面还有一个「查撤销预览失败」的 catch（那处没有刷新）
  const c = body.lastIndexOf("} catch (e) {");
  assert.ok(c >= 0, `${handler} 里没有 catch`);
  return body.slice(c);
}

console.log("装柜管理页面：失败提示不能被刷新冲掉");

check("刷新列表一进门就清报错（下面两条的前提）", () => {
  const at = source.indexOf("const loadList = useCallback");
  assert.ok(at >= 0, "找不到 loadList");
  assert.ok(source.slice(at, at + 400).includes('setError("")'), "loadList 里没有 setError(\"\")，这份测试的前提变了，去改测试");
});

for (const [handler, zh] of [["handleUndoStatus", "撤销"], ["handleDelete", "删除柜子"]] as const) {
  check(`${zh}失败：先刷新、最后才 setError（报错才留得住）`, () => {
    const block = catchBlockOf(handler);
    const err = block.indexOf("setError(");
    assert.ok(err >= 0, `${handler} 的 catch 里没有 setError`);
    const refreshes = [...block.matchAll(/await\s+loadList\(/g)].map((m) => m.index ?? -1);
    assert.ok(refreshes.length > 0, `${handler} 的 catch 里没有刷新列表`);
    const late = refreshes.filter((i) => i > err);
    assert.deepEqual(
      late.map((i) => block.slice(i, i + 40).split("(")[0].trim()),
      [],
      `${handler} 失败后还有刷新排在 setError 后面，报错会被清掉`,
    );
  });
}

check("撤销失败时不是笼统一句「撤销失败」盖掉后端的话", () => {
  const block = catchBlockOf("handleUndoStatus");
  assert.match(block, /e instanceof Error \? e\.message/, "撤销失败没有把后端说的原话显示出来");
});

console.log(`\nCHECKS ${failures === 0 ? "全过" : `失败 ${failures} 项`}`);
if (failures > 0) process.exitCode = 1;
