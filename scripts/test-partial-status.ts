/**
 * 「部分…」显示自测（2026-09-16）。不连数据库、不连外网。
 *
 * 老板 9-16 拍板：一票货拆了子单、子单进度不一样时，列表主状态**仍按最慢的那批**（分组、筛选、
 * 顶部数字口径一个字不改），后面补一句「（部分已放行）」把话说全。
 *
 * 盯住这几件事：
 *  1. 子单全一样 → 不补话（补了就是噪音）
 *  2. 子单有快有慢 → 补最快那个；主状态不动
 *  3. 父单自己还留着货（部分装柜）→ 主状态是父单自己那批，子单跑前面了也要补话
 *  4. 海运陆运两套流程分开比（陆运没有 departed/arrivedPort 那几步，别拿海运的序号去比）
 *  5. 子单比父单慢（数据本来就错的那 10 票）→ 不补话，等状态修好，别在客户那边再添一句
 *  6. 退回/取消的子单不参与比较；异常参与（它是该让人看见的）
 *  7. 没有子单 / 子单列表为空 → null
 */
import assert from "node:assert/strict";
import { partialAheadStatus } from "../packages/shared-types/shipment-status";

const failures: string[] = [];
let total = 0;
function check(name: string, body: () => void): void {
  total += 1;
  try {
    body();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`  ✗ ${name} —— ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log("「部分…」显示自测");

check("1 子单全一样 → 不补话", () => {
  assert.equal(partialAheadStatus("departed", ["departed", "departed"], 0, "sea"), null);
});

check("2 子单有快有慢 → 补最快的那个（YW0001497 真实形态）", () => {
  assert.equal(partialAheadStatus("departed", ["customsTH", "departed", "customsCleared"], 0, "sea"), "customsCleared");
});

check("3 父单自己还有货、子单跑前面了 → 补话（YW0001569 真实形态）", () => {
  assert.equal(partialAheadStatus("inWarehouseCN", ["departed"], 4, "sea"), "departed");
});

check("4 陆运按陆运流程比（atPortCn 在 loaded 后面）", () => {
  assert.equal(partialAheadStatus("loaded", ["atPortCn"], 0, "land"), "atPortCn");
  assert.equal(partialAheadStatus("atPortCn", ["loaded"], 0, "land"), null);
});

check("5 子单比父单慢（状态本来就错的那种）→ 不补话", () => {
  assert.equal(partialAheadStatus("delivered", ["inWarehouseTH"], 0, "sea"), null);
});

check("6 退回/取消的子单不参与；异常参与", () => {
  assert.equal(partialAheadStatus("departed", ["returned", "cancelled"], 0, "sea"), null);
  assert.equal(partialAheadStatus("departed", ["exception"], 0, "sea"), "exception");
});

check("7 没有子单 → null", () => {
  assert.equal(partialAheadStatus("departed", [], 0, "sea"), null);
});

check("8 流程表里没有的老状态 → 不补话，别瞎猜", () => {
  assert.equal(partialAheadStatus("departed", ["pickedUp"], 0, "sea"), null);
});

console.log(`\n共 ${total} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
