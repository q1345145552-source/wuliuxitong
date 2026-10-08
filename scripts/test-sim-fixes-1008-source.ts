/**
 * 2026-10-08 模拟数据测试查出来的问题 —— 源码级回归（不连库、不起服务）。连库的那一半见 test-sim-fixes-1008-db.ts。
 *
 * 盯的是「页面上接没接上」这类 tsc 照不到的地方，每一条在修之前的源码上都会失败：
 *   1) 员工 / 超管运单列表排序带 id 兜底（updatedAt 并列时翻页不重不漏）
 *   2) 超管列表 / 手机列表 / 详情的「到仓日期」走 adminArrivedDate（待入库没填不拿转单那天冒充）
 *   3) 袋装的单：员工 / 超管列表、手机列表、物流轨迹弹窗、预报单审核都按 packageUnit 写袋 / 箱；预报单审核不显示英文 bag / box、产品数量没填不写 0
 *   4) 轨迹接口（客户 / 代理）下发 packageUnit，弹窗才知道写「袋」
 *   5) 员工端改单把「打开时的剩余件数」带上去（后端据此拦编辑期间被装柜的旧数）
 *   —— 第 2 轮 ——
 *   6) 员工页「运单详情」全屏弹窗里显示保存失败的提示；保存失败后按最新数据重建草稿（旧：提示只在被盖住的页面底部，再点还是同一个 409）
 *   7) 超管「预报单管理」多产品横条按 packageUnit 写袋 / 箱（旧：写死「箱」）
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (p: string): string => readFileSync(path.join(root, p), "utf-8");

let failures = 0;
function check(name: string, run: () => void): void {
  try { run(); console.log(`  ✅ ${name}`); }
  catch (e) { failures++; console.log(`  ❌ ${name}\n     ${(e instanceof Error ? e.message : String(e)).split("\n").join("\n     ")}`); }
}
/** 圈出一个路由注册到下一个路由注册之间的源码 */
function routeBlock(src: string, decl: string): string {
  const start = src.indexOf(decl);
  assert.ok(start >= 0, `找不到 ${decl}`);
  const next = src.indexOf("\n  app.", start + decl.length);
  return src.slice(start, next < 0 ? undefined : next);
}

const staffPage = read("apps/web/src/app/staff/page.tsx");
const adminPage = read("apps/web/src/app/admin/page.tsx");

console.log("2026-10-08 模拟数据测试修复（源码）");

check("1) /staff/shipments、/admin/orders 排序带 id 兜底，并且在可重复读快照里查", () => {
  for (const [file, decl] of [
    ["apps/api/src/modules/shipments/routes.ts", 'app.get("/staff/shipments"'],
    ["apps/api/src/modules/admin/routes.ts", 'app.get("/admin/orders"'],
  ] as const) {
    const block = routeBlock(read(file), decl);
    assert.match(block, /orderBy: \[\{ updatedAt: "desc" \}, \{ id: "desc" \}\]/, `${decl} 排序没有 id 兜底`);
    assert.doesNotMatch(block, /orderBy: \{ updatedAt: "desc" \}/, `${decl} 还有只按 updatedAt 排的`);
    assert.match(block, /isolationLevel: Prisma\.TransactionIsolationLevel\.RepeatableRead/, `${decl} count / findMany 没放进可重复读快照`);
  }
});

check("2) 超管「到仓日期」三处都走 adminArrivedDate，不再直接退到建单日期", () => {
  assert.doesNotMatch(adminPage, /o\.shipDate \?\? beijingDate\(o\.createdAt\)/, "超管列表 / 手机列表还在 shipDate ?? 建单日期");
  assert.equal((adminPage.match(/adminArrivedDate\(o\) \|\| "—"/g) ?? []).length, 2, "列表格子和手机列表 meta 都要走 adminArrivedDate");
  const detail = read("apps/web/src/components/admin/AdminShipmentDetail.tsx");
  assert.match(detail, /\["到仓日期", display\(adminArrivedDate\(order\) \|\| undefined\)\]/);
});

check("3) 袋装的单：员工 / 超管列表和手机列表、轨迹弹窗、预报单审核按 packageUnit 写袋 / 箱", () => {
  for (const [who, src] of [["员工", staffPage], ["超管", adminPage]] as const) {
    assert.doesNotMatch(src, /packageUnit: "箱"/, `${who}手机列表单位还写死「箱」`);
    assert.doesNotMatch(src, /\$\{total\} 箱/, `${who}「总箱数」还写死「箱」`);
  }
  assert.match(staffPage, /packageUnit: packageUnitZh\(item\.packageUnit\)/);
  assert.match(adminPage, /packageUnit: packageUnitZh\(o\.packageUnit\)/);
  const track = read("apps/web/src/modules/shipment/ShipmentTrackModal.tsx");
  assert.doesNotMatch(track, /×\{p\.packageCount\}箱/, "轨迹弹窗产品行还写死「箱」");
  assert.match(track, /×\{p\.packageCount\}\{data\.packageUnit === "bag" \? "袋" : "箱"\}/);
  const prealert = read("apps/web/src/components/staff/StaffPrealertList.tsx");
  assert.doesNotMatch(prealert, /\$\{displayDraft\.packageCount\} \$\{displayDraft\.packageUnit\}`/, "预报单审核还直接显示英文 bag / box");
  assert.doesNotMatch(prealert, /value=\{String\(displayDraft\.productQuantity\)\}/, "产品数量没填时还显示 0");
  assert.doesNotMatch(prealert, /×\$\{p\.packageCount\}箱`/, "预报单产品行还写死「箱」");
});

check("4) 客户 / 代理两个轨迹接口都下发 packageUnit", () => {
  const client = routeBlock(read("apps/api/src/modules/containers/routes.ts"), 'app.get("/client/shipments/track"');
  assert.match(client, /packageUnit: shipment\.packageUnit \?\? null/);
  const agent = routeBlock(read("apps/api/src/modules/agent-portal/routes.ts"), 'app.get("/agent/shipments/track"');
  assert.match(agent, /packageUnit: true/);
  assert.match(agent, /packageUnit: shipment\.order\.packageUnit \?\? null/);
});

check("5) 员工端改单把打开时的剩余件数带上去", () => {
  assert.match(read("apps/web/src/modules/staff/utils.ts"), /basePackageCount: item\.packageCount \?\? null/, "草稿里没记打开时的剩余件数");
  assert.match(staffPage, /basePackageCount: draft\.basePackageCount/, "保存时没把它带上去");
  assert.match(read("apps/web/src/services/business-api.ts"), /basePackageCount\?: number \| null/);
});

check("6) 员工页运单详情弹窗里显示 message；保存失败后刷新并重建草稿", () => {
  const start = staffPage.indexOf('title="运单详情"');
  assert.ok(start >= 0, "找不到员工页的运单详情弹窗");
  const modal = staffPage.slice(start, staffPage.indexOf("</DetailModal>", start));
  assert.match(modal, /\{message \? \(\s*<p role="alert"[^>]*>\{message\}<\/p>/, "弹窗里没渲染 message（旧：只在页面最底下，被全屏弹窗盖住）");
  const save = staffPage.slice(staffPage.indexOf("const saveShipmentOrderEdit = async"), staffPage.indexOf("const mergeShipmentOrderDraft ="));
  const catchBlock = save.slice(save.indexOf("} catch (error) {"), save.indexOf("} finally {"));
  assert.match(catchBlock, /setMessage\(`保存失败：\$\{text\}`\)/);
  assert.match(catchBlock, /await loadPageData\(\)[\s\S]*buildShipmentOrderEditDraft\(updated\)/, "保存失败后没按最新数据重建草稿（旧：再点还是同一个 409）");
});

check("7) 超管「预报单管理」多产品横条按 packageUnit 写袋 / 箱", () => {
  const page = read("apps/web/src/app/admin/prealerts/page.tsx");
  assert.doesNotMatch(page, /×\$\{p\.packageCount\}箱`/, "超管预报单产品行还写死「箱」");
  assert.match(page, /×\$\{p\.packageCount\}\$\{item\.packageUnit === "bag" \? "袋" : "箱"\}`/);
});

if (failures > 0) { console.log(`❌ ${failures} 项失败`); process.exit(1); }
console.log("✅ 全部通过");
