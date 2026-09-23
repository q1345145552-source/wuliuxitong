/**
 * 运单导出：条件、口径、客户端那份的列（2026-09-23）。
 *
 * 老板 2026-09-23 原话：「客户端没有运单导出的功能，管理员端的导出也不能光选择日期，还要拥有那些搜索、筛选应该有的条件」。
 * 逐轮确认的结果：
 *   · 导出弹窗有自己的一套条件，打开时把列表上已经筛好的带进来，可以改、可以清空（老板回「行」）；
 *   · 日期按**到仓日期**（老板选 A）；
 *   · 客户端那份的列 = 管理员那套**去掉柜号**（老板：「1:去掉柜号」「3:对，除了柜号，其他一样」）；
 *   · 超管 / 员工 / 代理 / 客户四个端一起改（老板：「4:一起」）。
 *
 * 这份测试盯三件事（读源码 + 直接调真函数，不连库、不起服务）：
 *   ① 列表和导出用的是**同一份**判断（modules/shipment/export-filter.ts），别哪天改一边忘一边；
 *   ② 判断本身的口径（包含 / 相等 / 日期范围、三端各自的到仓日期和国内单号口径）；
 *   ③ 客户端导出的列跟管理员一致、**没有柜号**，四个端的弹窗都真的挂了条件组件。
 * 用法：npm run test:shipment-export
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = process.cwd();
const read = (p: string): string => readFileSync(path.join(root, p), "utf-8");

/** 把一个 .ts 模块编译出来直接调（跟 test-shipment-list-display 同一套办法） */
function loadModule(rel: string): Record<string, any> {
  const filename = path.resolve(root, rel);
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const moduleObject = { exports: {} as Record<string, any> };
  vm.runInNewContext("(function(exports,require,module){" + output + "\n})", { console }, { filename })(
    moduleObject.exports,
    createRequire(filename),
    moduleObject,
  );
  return moduleObject.exports;
}

const filter = loadModule("apps/web/src/modules/shipment/export-filter.ts");
const {
  EMPTY_SHIPMENT_FILTER, matchesShipmentFilter, mergeDateFrom, mergeDateTo, shipmentFilterDateInvalid,
  adminOrderFilterRow, staffShipmentFilterRow, clientOrderFilterRow,
} = filter;

let failures = 0;
function check(name: string, run: () => void): void {
  try {
    run();
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ ${name}\n     ${(e instanceof Error ? e.message : String(e)).split("\n").join("\n     ")}`);
  }
}
const cond = (patch: Record<string, string>) => ({ ...EMPTY_SHIPMENT_FILTER, ...patch });

const adminOrder = {
  id: "o1", trackingNo: "SZ260900123", domesticTrackingNo: "SF0001", clientName: "杨先", clientId: "XHH6700",
  warehouseId: "wh_yiwu_01", batchNo: "L2609", itemName: "鞋",
  products: [{ itemName: "鞋", sortOrder: 0, domesticTrackingNo: "SF0002" }, { itemName: "帽", sortOrder: 1 }],
  packageCount: 12, productQuantity: 120, weightKg: 88, volumeM3: 1.5,
  shipDate: "2026-09-10", createdAt: "2026-09-12T03:00:00.000Z", currentStatus: "inWarehouseCN",
  containerNo: "SEKU1234567", transportMode: "sea", receiverAddressTh: "曼谷某路 9 号", receivableAmountCny: 120.5,
};

console.log("运单导出（条件 + 客户端那份）");

check("1) 空条件放行所有单；日期反了的判断；两组日期合成一组取交集", () => {
  assert.equal(matchesShipmentFilter(adminOrderFilterRow(adminOrder), EMPTY_SHIPMENT_FILTER), true);
  // 列表上「到仓日期」和「发货日期」两组筛的是同一个字段，带进弹窗时取交集：起始取晚的、截止取早的
  assert.equal(mergeDateFrom("2026-09-10", "2026-09-01"), "2026-09-10");
  assert.equal(mergeDateFrom("", "2026-09-01"), "2026-09-01");
  assert.equal(mergeDateFrom("2026-09-10", ""), "2026-09-10");
  assert.equal(mergeDateFrom("", ""), "");
  assert.equal(mergeDateTo("2026-09-30", "2026-09-20"), "2026-09-20");
  assert.equal(mergeDateTo("", "2026-09-20"), "2026-09-20");
  assert.equal(mergeDateTo("2026-09-30", ""), "2026-09-30");
  assert.equal(shipmentFilterDateInvalid(cond({ shipDateFrom: "2026-09-10", shipDateTo: "2026-09-01" })), true);
  assert.equal(shipmentFilterDateInvalid(cond({ arrivedAtFrom: "2026-09-10", arrivedAtTo: "2026-09-01" })), true);
  assert.equal(shipmentFilterDateInvalid(cond({ shipDateFrom: "2026-09-01", shipDateTo: "2026-09-10" })), false);
});

check("2) 文本条件是「包含」且不分大小写；仓库 / 状态 / 运输方式是「完全相等」", () => {
  const row = adminOrderFilterRow(adminOrder);
  assert.equal(matchesShipmentFilter(row, cond({ trackingNo: "sz2609" })), true, "运单号要能按一段搜、不分大小写");
  assert.equal(matchesShipmentFilter(row, cond({ trackingNo: " SZ260900123 " })), true, "前后空格要先去掉");
  assert.equal(matchesShipmentFilter(row, cond({ trackingNo: "SZ999" })), false);
  assert.equal(matchesShipmentFilter(row, cond({ clientName: "XHH6700" })), true, "唛头能搜");
  assert.equal(matchesShipmentFilter(row, cond({ clientName: "杨先" })), true, "客户名也能搜");
  assert.equal(matchesShipmentFilter(row, cond({ itemName: "帽" })), true, "品名要认全部产品名（2026-09-11 那条）");
  assert.equal(matchesShipmentFilter(row, cond({ warehouseId: "wh_yiwu_01" })), true);
  assert.equal(matchesShipmentFilter(row, cond({ warehouseId: "wh_guangzhou_01" })), false);
  assert.equal(matchesShipmentFilter(row, cond({ transportMode: "sea" })), true);
  assert.equal(matchesShipmentFilter(row, cond({ transportMode: "land" })), false);
  assert.equal(matchesShipmentFilter(row, cond({ logisticsStatus: "已入库" })), true, "状态下拉里选的是中文");
  assert.equal(matchesShipmentFilter(row, cond({ logisticsStatus: "派送完成" })), false);
});

check("3) 日期按到仓日期（老板 2026-09-23 选 A）：范围两头都算进去", () => {
  const row = adminOrderFilterRow(adminOrder); // 到仓 2026-09-10
  assert.equal(matchesShipmentFilter(row, cond({ shipDateFrom: "2026-09-10" })), true, "起始日当天要算进去");
  assert.equal(matchesShipmentFilter(row, cond({ shipDateTo: "2026-09-10" })), true, "截止日当天要算进去");
  assert.equal(matchesShipmentFilter(row, cond({ shipDateFrom: "2026-09-11" })), false);
  assert.equal(matchesShipmentFilter(row, cond({ shipDateTo: "2026-09-09" })), false);
  assert.equal(matchesShipmentFilter(row, cond({ shipDateFrom: "2026-09-01", shipDateTo: "2026-09-30" })), true);
});

check("4) 三个端各自的口径：到仓日期、国内单号、加收金额", () => {
  // 管理员端：没有到仓日期时退到建单日期（原来的写法）
  const noShipDate = adminOrderFilterRow({ ...adminOrder, shipDate: null });
  assert.equal(noShipDate.arrivedAt, "2026-09-12", "管理员端没到仓日期就用建单日期");
  assert.equal(noShipDate.shipDate, "", "但「到仓日期」那一格是空的，不拿建单日期冒充");
  // 员工端：产品行上的国内单号也要能搜到；加收金额按两位小数比
  const staffRow = staffShipmentFilterRow({ ...adminOrder, arrivedAt: "2026-09-08T00:00:00.000Z" });
  assert.equal(matchesShipmentFilter(staffRow, cond({ domesticTrackingNo: "SF0002" })), true, "员工端要能搜产品行的国内单号");
  assert.equal(staffRow.arrivedAt, "2026-09-08", "员工端到仓日期用 arrivedAt");
  assert.equal(matchesShipmentFilter(staffRow, cond({ receivableAmount: "120.50" })), true, "员工端加收金额是两位小数");
  // 管理员端那份不带产品行的国内单号（保持原样，不顺手改口径）
  assert.equal(matchesShipmentFilter(adminOrderFilterRow(adminOrder), cond({ domesticTrackingNo: "SF0002" })), false);
});

check("5) 客户端：状态用客户那套说法；建单日期和到仓日期各管各的", () => {
  const row = clientOrderFilterRow(
    { ...adminOrder, createdAt: "2026-09-12T03:00:00.000Z", shipDate: "2026-09-10", currentStatus: "delivered" },
    { delivered: "已送达" },
  );
  assert.equal(row.logisticsStatus, "已送达", "客户端状态名要用传进来的那套");
  assert.equal(row.arrivedAt, "2026-09-12", "客户端那组日期筛的是建单日期");
  assert.equal(row.shipDate, "2026-09-10", "到仓日期另算");
  assert.equal(matchesShipmentFilter(row, cond({ arrivedAtFrom: "2026-09-12", shipDateTo: "2026-09-10" })), true);
  assert.equal(matchesShipmentFilter(row, cond({ arrivedAtFrom: "2026-09-13" })), false);
  assert.equal(row.containerNo, "", "客户看不到柜号，这一项恒为空");
  assert.equal(row.batchNo, "", "批次号同上");
});

check("6) 列表和导出用同一份判断（四个端的页面都真的在调它）", () => {
  const adminPage = read("apps/web/src/app/admin/page.tsx");
  const staffPage = read("apps/web/src/app/staff/page.tsx");
  assert.match(adminPage, /filteredOrderList = useMemo\([\s\S]{0,400}matchesShipmentFilter\(adminOrderFilterRow\(item\), orderSearch\)/, "超管列表没走共用判断");
  assert.match(adminPage, /matchesShipmentFilter\(adminOrderFilterRow\(item\), exportFilter\)/, "超管导出没走共用判断");
  assert.match(staffPage, /filteredShipmentList = useMemo\([\s\S]{0,400}matchesShipmentFilter\(staffShipmentFilterRow\(item\), shipmentSearch\)/, "员工列表没走共用判断");
  assert.match(staffPage, /matchesShipmentFilter\(staffShipmentFilterRow\(item\), exportFilter\)/, "员工导出没走共用判断");
  assert.match(read("apps/web/src/app/client/page.tsx"), /matchesShipmentFilter\(clientOrderFilterRow\(item as any, CLIENT_STATUS_ZH_OVERRIDES\), exportFilter\)/, "客户导出没走共用判断");
  // 页面里不许再各写一套：老的那串逐字段比对不能回来
  for (const [who, src] of [["超管", adminPage], ["员工", staffPage]] as Array<[string, string]>) {
    assert.ok(!/if \(s\.trackingNo && !trackingNo\.includes/.test(src) && !/if \(trackingNoKeyword && !trackingNo\.includes/.test(src), `${who}页面里又出现了自己那份筛选判断`);
  }
});

check("7) 四个端的导出弹窗都挂了条件组件，而且不是只剩日期", () => {
  const pages: Array<[string, string]> = [
    ["超管", "apps/web/src/app/admin/page.tsx"],
    ["员工", "apps/web/src/app/staff/page.tsx"],
    ["客户", "apps/web/src/app/client/page.tsx"],
    ["代理", "apps/web/src/components/agent/AgentShipments.tsx"],
  ];
  for (const [who, file] of pages) {
    const src = read(file);
    assert.match(src, /<ExportConditionFields/, `${who}端导出弹窗没挂条件组件`);
    assert.match(src, /onOpen=\{prefillExport/, `${who}端打开弹窗时没把列表条件带进来`);
    assert.match(src, /onClear=\{/, `${who}端弹窗没有「清空条件」`);
    // 老的「只有两个日期框」的写法不许回来
    assert.ok(!/导出起始日期/.test(src), `${who}端还留着只有日期的老写法`);
  }
  // 常用条件里要有日期、状态、仓库、运输方式、客户、运单号这几样（超管 / 员工）
  for (const [who, file] of pages.slice(0, 2)) {
    const src = read(file);
    // 日期这一格必须绑 arrivedAt*：跟列表「到仓日期」同一个口径（没填到仓日期就退到建单日期），
    // 绑成 shipDate* 会把「列表查得到、导出却漏掉」那种坑带回来（2026-09-23 复核）
    for (const key of ["arrivedAtFrom", "arrivedAtTo", "logisticsStatus", "warehouseId", "transportMode", "clientName", "trackingNo"]) {
      assert.ok(new RegExp(`key: "${key}"`).test(src), `${who}端导出条件里少了 ${key}`);
    }
    for (const key of ["domesticTrackingNo", "itemName", "containerNo", "receivableAmount"]) {
      assert.ok(new RegExp(`key: "${key}"`).test(src), `${who}端「更多条件」里少了 ${key}`);
    }
    assert.match(src, /arrivedAtFrom: mergeDateFrom\(/, `${who}端带入列表日期时没取交集`);
    assert.match(src, /arrivedAtTo: mergeDateTo\(/, `${who}端带入列表日期时没取交集`);
  }
  // 四个端都要有「运单分组」，客户端也不例外（少了它客户切了页签导出还是全部，2026-09-23 复核）
  for (const [who, file] of pages) {
    const src = read(file);
    assert.ok(/key: "(group|statusGroup)"/.test(src), `${who}端导出条件里少了「运单分组」`);
  }
  assert.match(read("apps/web/src/app/client/page.tsx"),
    /fetchClientOrders\(exportGroup === "all" \? undefined : \{ statusGroup: exportGroup \}\)/,
    "客户端导出没按弹窗里的分组去拉数据");
});

check("8) 客户端导出的列 = 管理员那套去掉柜号（老板 2026-09-23：「除了柜号，其他一样」）", () => {
  const adminPage = read("apps/web/src/app/admin/page.tsx");
  const clientPage = read("apps/web/src/app/client/page.tsx");
  const columnsOf = (src: string, from: string) => {
    const start = src.indexOf(from);
    assert.ok(start > 0, `找不到导出那段：${from}`);
    const block = src.slice(start, src.indexOf("json_to_sheet", start));
    /* 一行里可能写了好几列（`运输方式: x, 国内单号: y, 柜号: z`），所以整段找「列名:」。
       冒号后**不许要求有空格**：写成 `柜号:o.batchNo` 一样是一列，以前的正则会漏掉它（2026-09-23 复核）。
       注释行先去掉，免得把注释里的「口径:」之类当成列名。 */
    const code = block.split("\n").filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join("\n");
    return [...code.matchAll(/(?:^|[\s,{])([\u4e00-\u9fa5A-Za-z0-9]+)\s*:/gm)].map((m) => m[1]);
  };
  const adminCols = columnsOf(adminPage, "const rows = source.map((o) => ({");
  const clientCols = columnsOf(clientPage, "const rows = matched.map((o: any) => ({");
  assert.ok(adminCols.includes("柜号"), "管理员那套本来就有柜号（口径变了这条测试要跟着改）");
  assert.ok(!clientCols.includes("柜号"), "客户导出里出现了柜号 —— 客户不能看柜号");
  assert.ok(!clientCols.includes("客户"), "客户那份把「客户」列改成了「唛头」，这里不该再有「客户」");
  /* 老板原话「除了柜号，其他一样」：两边**双向**比。
     只比「客户那份少没少」是不够的 —— 多出来的列同样是不一样（2026-09-23 复核）。 */
  const missing = adminCols.filter((c) => !["柜号", "客户"].includes(c) && !clientCols.includes(c));
  assert.deepEqual(missing, [], `客户导出少了这些列：${missing.join("、")}`);
  const extra = clientCols.filter((c) => c !== "唛头" && !adminCols.includes(c));
  assert.deepEqual(extra, [], `客户导出比管理员那套多了这些列：${extra.join("、")}`);
  assert.ok(clientCols.includes("唛头"), "客户导出要有唛头那一列");
  assert.ok(clientCols.includes("物流状态") && adminCols.includes("物流状态"), "两边都要有物流状态这一列");
  // 客户那份不许把内部字段带出去
  for (const bad of ["加收金额", "备注", "批次号", "操作人", "客户名"]) {
    assert.ok(!clientCols.includes(bad), `客户导出里出现了不该给的列：${bad}`);
  }
});

check("9) 代理端导出：条件走弹窗，而且照旧没有柜号那一列", () => {
  const src = read("apps/web/src/components/agent/AgentShipments.tsx");
  assert.match(src, /statusGroup: \(exportCond\.statusGroup/, "代理导出没用弹窗里的分组");
  assert.match(src, /dateFrom: exportCond\.dateFrom \|\| undefined/, "代理导出没用弹窗里的日期");
  assert.match(src, /trackingNo: exportCond\.trackingNo\.trim\(\) \|\| undefined/, "代理导出没用弹窗里的运单号");
  assert.ok(!/filtersForExport/.test(src), "代理导出还在用列表上的条件");
  assert.ok(!/柜号:/.test(src), "代理导出里出现了柜号");
});

if (failures > 0) {
  console.log(`❌ 失败 ${failures} 项`);
  process.exit(1);
}
console.log("✅ 运单导出：9 项全部通过");
