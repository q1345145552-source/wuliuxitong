/**
 * 2026-09-29 老板报「询价记录每次都要点加载才能出来」之后全前端扫出来的同类毛病（老板选 A：三处都改）——
 * 不连库、不起浏览器的回归，读源码钉住「在哪几个时刻会去拉」。每条都是「改回去就红」。
 * （询价记录本身在 test-cs-chat-ui-behavior.ts 的 U10 里真跑。）
 *
 *   W1 员工端「财务 → 客户集货余额」：原来只有点「刷新」才拉，每次进来都是「暂无数据，点击刷新加载」；
 *      失败只在控制台打一行、页面上跟没数据一样 → 切到这一栏就自己拉，失败写原因、「重试」点一下就拉
 *   W2 客户端「集货拼柜(仓库版)」看详情：没拉到时只弹 5 秒就消失的提示、那一行还高亮着、下面一片空白，
 *      再点那一行只会取消选中 → 写出原因 + 「点击重试」点一下就重拉（跟普通版集货一样）
 *   W3 运单页顶上那排数字（在途 / 延迟·查验 / 已到仓 / 本月已签收）：三端原来都只在打开页面时拉一次，
 *      下面的列表会刷新、数字不动，两边对不上 → 跟着列表一起拉；拉不到保留上一次的数（不清成空）
 *
 * 做法：按函数名 / effect 开头找到那一段代码，数大括号截出整段函数体，再断言里面调了该调的 ——
 * 不是在整个文件里搜一个词（那样挪到别处、写进注释都照样绿）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
let passed = 0, failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
}

/**
 * 去掉注释（行注释 + 块注释），免得「写在注释里」也算数。
 * ⚠️ 引号里的内容要原样跳过：第一版只按「/*」认块注释，把 accept="image/*" 当成注释开头，
 * 一口吞掉几十到一百多行真代码（复核实测：往被吞的那段塞一句坏代码，测试照样绿）。
 * 单双引号只认同一行里配对的（JSX 文字里落单的撇号不会一路吞下去）。
 */
function stripComments(src: string): string {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_m, str) => str ?? "");
}

/** 从 marker **末尾**往后找第一个「{」，数括号截出整段（含两头的大括号）。marker 必须唯一。
 *  从末尾找（2026-10-05 改）：参数里带类型的 marker（`(opts?: { silent?: boolean }) =>`）从开头找会先碰到类型的大括号 */
function block(src: string, marker: string): string {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, `源码里找不到「${marker}」`);
  assert.equal(src.indexOf(marker, at + 1), -1, `「${marker}」出现了不止一次，定位不唯一`);
  const open = src.indexOf("{", at + marker.length);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  throw new Error(`「${marker}」后面的大括号没配平`);
}

/** 所有 useEffect(...) 调用的全文（含依赖数组） */
function effects(src: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf("useEffect(", from);
    if (at < 0) return out;
    let depth = 0, i = at + "useEffect".length;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") { depth--; if (depth === 0) break; }
    }
    out.push(src.slice(at, i + 1));
    from = i + 1;
  }
}

/** 顶上那排数字的加载函数：领号验号、失败不清空（保留上一次的数） */
function assertOverviewLoader(src: string, fetchName: string, where: string) {
  const body = block(src, "const loadShipmentOverview = async () =>");
  assert.match(body, new RegExp(`await ${fetchName}\\(\\)`), `${where}：加载函数没去拉 ${fetchName}`);
  assert.match(body, /shipmentOverviewGate\.begin\(\)/, `${where}：没领号（慢的旧请求会盖掉新的）`);
  assert.match(body, /if \(shipmentOverviewGate\.isCurrent\(ticket\)\) setShipmentOverview\(data\)/, `${where}：回来没验号就写数`);
  assert.doesNotMatch(body, /setShipmentOverview\(null\)/, `${where}：拉失败把已有的数清空了（10 秒一轮，网一抖整排就消失）`);
  // 全文件只有这一处写这排数字（不许另起一个只拉一次的 effect 绕过去）
  assert.equal((src.match(/setShipmentOverview\(/g) ?? []).length, 1, `${where}：setShipmentOverview 不止一处写`);
  assert.doesNotMatch(src, new RegExp(`${fetchName}\\(\\)\\.then\\(setShipmentOverview\\)`), `${where}：还留着「只在打开页面拉一次」的老写法`);
}

/** 「上一份还没回来」的标记：出发时立起，只有最新那一份能放倒（不然旧的回来先放倒，轮询又会叠着发） */
function assertPendingClears(src: string, where: string) {
  const body = block(src, "const loadShipmentOverview = async () =>");
  assert.match(body, /shipmentOverviewGate\.begin\(\);\s*shipmentOverviewPending\.current = true;/, `${where}：出发时没立「还没回来」的标记`);
  assert.match(body, /finally \{\s*if \(shipmentOverviewGate\.isCurrent\(ticket\)\) shipmentOverviewPending\.current = false;/, `${where}：标记放倒不对（永远不放倒 → 轮询再也不拉数字）`);
}

const STAFF = stripComments(read("apps/web/src/app/staff/page.tsx"));
const ADMIN = stripComments(read("apps/web/src/app/admin/page.tsx"));
const CLIENT = stripComments(read("apps/web/src/app/client/page.tsx"));
const WHR = stripComments(read("apps/web/src/app/client/whr-consolidation/page.tsx"));

check("W1 员工「客户集货余额」切到这一栏就自己拉（每次切进来都拉），不是只有点「刷新」才拉", () => {
  const hits = effects(STAFF).filter((e) => /loadWalletBalances\(\)/.test(e));
  assert.equal(hits.length, 1, `应有且只有一个 effect 去拉客户余额，实际 ${hits.length} 个`);
  assert.match(hits[0], /if \(activeSection === "staff-wallet"\) void loadWalletBalances\(\)/, "effect 不是「切到 staff-wallet 就拉」");
  assert.match(hits[0], /\},\s*\[activeSection\]\)$/, "effect 的依赖不是 [activeSection]（切回来不会重拉）");
  assert.doesNotMatch(STAFF, /点击刷新加载/, "还留着「暂无数据，点击刷新加载」");
});

check("W1 员工「客户集货余额」拉失败写出原因（不再只打控制台），「重试」点一下就真去拉", () => {
  // 2026-10-05 加了 silent 参数（实时推送时悄悄重拉），下面查的每一条照旧
  const body = block(STAFF, "const loadWalletBalances = async (opts?: { silent?: boolean }) =>");
  assert.doesNotMatch(body, /console\.error/, "失败还是只在控制台打一行");
  assert.match(body, /setWalletError\(e instanceof Error \? e\.message : "网络错误"\)/, "失败没记下原因");
  assert.match(body, /walletGate\.begin\(\)/, "没领号");
  // 复核补：只查「领了号」不够 —— 验号、收尾、成功清提示删掉任何一处都要红
  assert.match(body, /if \(!walletGate\.isCurrent\(ticket\)\) return;\s*setWalletBalances/, "成功回来没验号（慢的旧请求会盖掉新的）");
  assert.match(body, /catch \(e\) \{\s*if \(!walletGate\.isCurrent\(ticket\)\) return;/, "失败回来没验号（旧的失败会压住新的成功）");
  assert.match(body, /finally \{\s*if \(walletGate\.isCurrent\(ticket\)\) setWalletLoading\(false\);/, "收尾不对（「刷新中…」会卡住，或被旧请求提前收掉）");
  assert.match(body, /setWalletBalances\(data\.balances\);\s*setWalletError\(""\);/, "拉成功了没把上一次的失败提示清掉");
  const alertAt = STAFF.indexOf("客户余额没加载出来");
  assert.ok(alertAt > 0, "页面上没有失败提示");
  const retry = STAFF.slice(alertAt, alertAt + 600);
  assert.match(retry, /onClick=\{\(\) => void loadWalletBalances\(\)\}/, "「重试」按钮点了不直接重拉");
  assert.match(STAFF, /!walletLoaded \?\s*\(\s*walletError \? null : <p[^>]*>加载中…<\/p>/, "第一次拉的时候没写「加载中…」");
});

check("W2 客户「集货拼柜(仓库版)」详情没拉到：记下原因、写「详情加载失败」，「点击重试」点一下就重拉", () => {
  // 2026-10-05 加了 silent 参数（实时推送时悄悄重拉），下面查的每一条照旧
  const body = block(WHR, "const loadDetail = useCallback(async (planId: string, opts?: { silent?: boolean }) =>");
  // 复核补：先认主人再领号 —— 不是当前选中的计划就不拉，不去作废当前那一份（原来保存 A 时点了 B，B 会一片空白）
  // 2026-10-05：认主人和领号中间多了两句（silent 标记、给用户的请求让路 —— 让路时连号都不领），顺序照旧是先认主人
  assert.match(body, /^\{\s*if \(selectedPlanIdRef\.current !== planId\) return;\s*const silent = opts\?\.silent === true;\s*if \(silent && !detailYield\.allowSilent\([^\n]*\)\) return;\s*const ticket = detailGate\.begin\(\);/, "没有「先认主人再领号」");
  assert.equal((body.match(/if \(!detailGate\.isCurrent\(ticket\) \|\| selectedPlanIdRef\.current !== planId\) return;/g) ?? []).length, 2, "成功、失败两个分支都要验号 + 认主人");
  assert.match(body, /setDetailError\(e\?\.message \|\| "加载失败"\)/, "失败没记下原因（只弹 5 秒就消失的提示）");
  assert.match(body, /setDetailLoading\(true\);\s*setDetailError\(""\);/, "重新拉的时候没把上一次的失败提示清掉");
  const at = WHR.indexOf("详情加载失败：{detailError}");
  assert.ok(at > 0, "页面上没有「详情加载失败」");
  const around = WHR.slice(at - 300, at + 400);
  assert.match(around, /selectedPlanId && !detailLoading && !detail && detailError/, "失败提示的显示条件不对");
  assert.match(around, /onClick=\{\(\) => \{ if \(selectedPlanId\) loadDetail\(selectedPlanId\); \}\}/, "「点击重试」点了不直接重拉（原来要再点两下那一行）");
});

check("W3 超管运单页顶上那排数字：开页、10 秒轮询、「刷新」按钮都跟列表一起拉", () => {
  assertOverviewLoader(ADMIN, "fetchStaffShipmentOverview", "超管");
  // 2026-10-05：10 秒轮询换成 useLiveRefresh（有变化马上刷 + 10 秒兜底），里面拉的东西照旧
  const live = block(ADMIN, "refresh: async (_wanted, reason) =>");
  assert.match(live, /loadOrders\(\)/, "（定位错了：这不是列表的 10 秒轮询）");
  assert.match(live, /shipmentOverviewPending\.current \? null : loadShipmentOverview\(\)/, "10 秒轮询不刷数字，或者上一轮没回来也照发（接口慢过 10 秒时每一份都被下一轮作废，数字永远出不来）");
  const call = ADMIN.slice(ADMIN.lastIndexOf("useLiveRefresh({", ADMIN.indexOf("refresh: async (_wanted, reason) =>")), ADMIN.indexOf("refresh: async (_wanted, reason) =>"));
  assert.match(call, /pollMs: 10000,\s*livePollMs: 10000,/, "兜底轮询不是 10 秒了");
  assertPendingClears(ADMIN, "超管");
  const refresh = block(ADMIN, "const refreshOrderList = async () =>");
  assert.match(refresh, /void loadShipmentOverview\(\)/, "点「刷新」只刷列表、不刷数字");
  // 复核补：不能拿 10 秒轮询那个 effect（依赖也是 []）顶替 —— 要有一个专门「开页拉一次」的
  assert.ok(effects(ADMIN).some((e) => e.replace(/\s+/g, " ") === "useEffect(() => { void loadShipmentOverview(); }, [])"), "打开页面时不拉数字（前 10 秒不出来；标签页在后台时轮询跳过，就一直不出来）");
});

check("W3 员工运单页顶上那排数字：跟列表一起拉（loadPageData 每次都顺带拉，开页那次也是）", () => {
  assertOverviewLoader(STAFF, "fetchStaffShipmentOverview", "员工");
  const body = block(STAFF, "const loadPageData = async (): Promise<ShipmentItem[]> =>");
  assert.match(body, /void loadShipmentOverview\(\)/, "刷新列表时不刷数字（员工自己改了状态，数字不变）");
  assert.ok(effects(STAFF).some((e) => /loadPageData\(\)/.test(e) && /\},\s*\[\]\)$/.test(e)), "打开页面时不拉列表（也就不拉数字）");
});

check("W3 客户运单查询顶上那排数字：切到「运单查询」、10 秒轮询、执行查询、切分组都跟列表一起拉", () => {
  assertOverviewLoader(CLIENT, "fetchClientShipmentOverview", "客户");
  // 2026-10-05：10 秒轮询换成 useLiveRefresh（有变化马上拉 + 10 秒兜底），里面每一步照旧
  const poll = block(CLIENT, "refresh: async (isStillWanted) =>");
  assert.match(poll, /fetchClientOrders/, "（定位错了：这不是运单列表的 10 秒轮询）");
  assert.match(poll, /if \(!shipmentOverviewPending\.current\) void loadShipmentOverview\(\)/, "10 秒轮询不刷数字，或者上一轮没回来也照发");
  assertPendingClears(CLIENT, "客户");
  assert.match(block(CLIENT, "const runOrderQuery = async () =>"), /void loadShipmentOverview\(\)/, "执行查询时不刷数字");
  assert.match(block(CLIENT, "const changeQueryMode = (mode: ShipmentGroupFilter) =>"), /void loadShipmentOverview\(\)/, "切分组时不刷数字");
  const enter = effects(CLIENT).filter((e) => /if \(activeSection === "client-query"\) void loadShipmentOverview\(\)/.test(e));
  assert.equal(enter.length, 1, "切到「运单查询」时不拉数字");
  assert.match(enter[0], /\},\s*\[activeSection\]\)$/, "依赖不是 [activeSection]（切回来不会重拉）");
});

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) process.exit(1);
