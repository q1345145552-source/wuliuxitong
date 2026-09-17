/**
 * 代理端「集货拼柜 / 集货余额 / 客户和价格 / 我的价格」暂时关掉（2026-09-18 老板拍板）。
 *
 * 老板原话：「暂时不对代理开放集货拼柜的功能，对应的映射那些也一起关掉，就是余额，价格设置那些。
 * 但是后端暂时保留一下，以后可能会用。」
 *
 * 所以这份测试盯两头：
 *   ① 关的这四样在**前端**真的看不见、也不发请求（菜单没有、分区不渲染、首页不拉集货数据、旧链接回首页）；
 *   ② 组件文件和**后端接口一个都没删**（以后要开回来就改一个开关）。
 *
 * 不连数据库、不起服务。用法：npm run test:agent-whr-disabled
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string): string => readFileSync(path.join(process.cwd(), p), "utf-8");
const flags = read("apps/web/src/modules/agent/agent-features.ts");
const page = read("apps/web/src/app/agent/page.tsx");
const home = read("apps/web/src/components/agent/AgentHome.tsx");
const menu = read("apps/web/src/modules/layout/menu-config.ts");

let failures = 0;
/** ⚠️ 必须 await：上一版写成同步 `fn()`，异步用例的断言在 `await import` 之后永远不执行 —— 假绿（DeepSeek 复核 2026-09-18 第 4 条） */
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ ${name}\n     ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
}

async function main(): Promise<void> {
  console.log("代理端集货相关分区（暂时关闭）");

  await check("1) 开关在一个地方，现在是关的；关掉的分区正好是那四个", () => {
  assert.match(flags, /export const AGENT_WHR_FEATURES_ENABLED = false;/, "开关不是 false（要开回来是老板说了才行）");
  assert.match(flags, /AGENT_DISABLED_SECTIONS = \["whr", "clients", "wallet", "me"\] as const;/, "关掉的分区名单不对");
});

  await check("2) 菜单里没有那四项，剩下首页 / 运单 / 返现单", async () => {
  const mod = await import("../apps/web/src/modules/layout/menu-config");
  const items = mod.roleFunctionGroups.agent.flatMap((g: { items: Array<{ id: string; label: string }> }) => g.items);
  assert.deepEqual(items.map((i) => i.id), ["agent-func-home", "agent-func-shipments", "agent-func-rebates"], `代理菜单现在是 ${items.map((i) => i.label).join(" / ")}`);
  // 源码里那四项还留着（用开关包起来），以后开回来不用重新写
  for (const id of ["agent-func-whr", "agent-func-clients", "agent-func-wallet", "agent-func-me"]) {
    assert.ok(menu.includes(id), `menu-config 里把 ${id} 删掉了，以后开不回来`);
  }
  assert.ok(menu.includes("AGENT_WHR_FEATURES_ENABLED"), "菜单没跟着开关走");
});

  await check("3) 页面：那四个分区渲染前都判开关；旧链接（#whr 等）回首页", () => {
  for (const section of ["whr", "clients", "wallet", "me"]) {
    // 渲染和 hash 那道闸必须用同一份判断（isAgentSectionEnabled），别一个看全局开关、一个看名单
    const re = new RegExp(`isAgentSectionEnabled\\("${section}"\\) && section === "${section}"`);
    assert.match(page, re, `分区 ${section} 没用 isAgentSectionEnabled 判，关着也会渲染 / 将来单独放开会出空白页`);
  }
  assert.match(page, /isSectionId\(id\) && isAgentSectionEnabled\(id\)/, "旧链接没挡：#whr 这种会渲染半截页面");
  assert.match(page, /if \(!isAgentSectionEnabled\("whr"\)\) return;/, "首页「看明细」那条跳转没判开关");
  assert.match(page, /if \(raw && raw !== next\)/, "旧链接退回首页时没把地址栏的 # 改掉（左边菜单会一个都不高亮）");
  // ⚠️ 退回必须 replaceHash（改掉这条历史记录）；用 navigateToHash 会新增一条 →
  //    按「后退」回到 #whr，这段又把他推回 #home，后退永远出不去（复核 2026-09-18）
  assert.match(page, /replaceHash\(`\$\{window\.location\.pathname\}\$\{window\.location\.search\}#\$\{next\}`\)/, "旧链接退回首页用的是 pushState 那条路，用户按后退会被死死困在首页");
  assert.match(page, /section === "rebates" \? <AgentRebates \/>/, "返现单被连带关掉了（这个要留）");
  assert.match(page, /section === "shipments" \? <AgentShipments \/>/, "运单被连带关掉了（这个要留）");
});

  await check("4) 首页：关着时不发集货请求，只写一句话说去哪看", () => {
  const start = home.indexOf("export default function AgentHome");
  const body = home.slice(start, home.indexOf("function AgentHomeStuck"));
  assert.match(body, /if \(!AGENT_WHR_FEATURES_ENABLED\)/, "首页没判开关");
  assert.ok(!body.includes("useAgentLoad"), "关着还在拉集货数据（白占后端）");
  assert.match(body, /在「运单」里看|返现单/, "没告诉代理去哪看");
  // 开回来那条路还在
  assert.ok(home.includes("fetchAgentDashboard"), "把拉数据的代码删了，以后开不回来");
});

  await check("5) 组件文件一个都没删（只是暂时不渲染）", () => {
  for (const f of ["AgentWhr.tsx", "AgentWallet.tsx", "AgentClients.tsx", "AgentMe.tsx"]) {
    assert.ok(existsSync(path.join(process.cwd(), "apps/web/src/components/agent", f)), `${f} 被删了`);
  }
});

  await check("5b) 集货三个弹窗的报错画在弹窗里面（不是页面顶部那条，会被遮罩压住还自动消失）", () => {
    const admin = read("apps/web/src/app/admin/whr-consolidation/page.tsx");
    const staff = read("apps/web/src/app/staff/whr-consolidation/page.tsx");
    assert.match(admin, /const \[modalError, setModalError\] = useState\(""\);/, "管理员端集货页没有弹窗内报错");
    assert.equal((admin.match(/\{modalError && \(/g) ?? []).length, 3, "建柜 / 改单价 / 加客户三个弹窗都要有报错条");
    for (const fn of ["创建失败", "改单价失败", "新增失败"]) {
      assert.ok(admin.includes(`setModalError(e?.message ?? "${fn}")`), `${fn} 还写在页面顶部那条 toast 上`);
    }
    assert.match(staff, /const \[addError, setAddError\] = useState\(""\);/, "员工端加客户弹窗没有弹窗内报错");
    assert.ok(staff.includes('setAddError(e?.message ?? "新增失败")'), "员工端新增失败还写在 toast 上");
  });

  await check("5c) 改单价：只有在跑的柜能改、只发真的改过的那几档、老柜 0 价不预填", () => {
    const admin = read("apps/web/src/app/admin/whr-consolidation/page.tsx");
    const staff = read("apps/web/src/app/staff/whr-consolidation/page.tsx");
    assert.match(admin, /\["planning", "collecting", "loading"\]\.includes\(planDetail\.status\)/, "已发运 / 已完成的柜还显示「改单价」");
    assert.match(admin, /const changed = \(input: string, current: number\)/, "没做「只发改过的档」，会把别人刚改的覆盖回去");
    assert.match(admin, /Number\(v\) > 0 \? String\(v\) : ""/, "老柜里 0 价会被预填成 \"0\"，整次保存会被自己的校验拦死");
    // 单价校验只许有**一份**（管理员端 / 员工端各抄一份，改了后端规则必漏一边）
    for (const [who, src] of [["管理员端", admin], ["员工端", staff]] as Array<[string, string]>) {
      assert.ok(src.includes('from "../../../modules/shared/unit-price"'), `${who}集货页没用公共的单价校验`);
      assert.ok(!src.includes("function unitPriceIssue("), `${who}集货页自己又抄了一份单价校验`);
    }
    const shared = read("apps/web/src/modules/shared/unit-price.ts");
    assert.match(shared, /value >= 100000000/, "公共校验没卡单价上限（后端是 Decimal(10,2)）");
    assert.match(shared, /value < 0.01/, "公共校验没卡下限 0.01（0.001 会被存成 0，这一柜白送）");
  });

  await check("6) 后端接口一个都没删（老板要求保留）", () => {
  const routes = read("apps/api/src/modules/agent-portal/routes.ts");
  for (const route of ["/agent/whr/plans", "/agent/wallet", "/agent/clients", "/agent/me"]) {
    assert.ok(routes.includes(route), `后端 ${route} 被删了（老板说后端暂时保留）`);
  }
  assert.ok(existsSync(path.join(process.cwd(), "apps/api/src/modules/whr-consolidation/long-term-price.ts")), "long-term-price.ts 被删了（后端要留）");
  // 但两个**写**接口在功能关闭期间必须拒绝：不然一打就把柜里当场填的价覆盖掉
  const ltp = read("apps/api/src/modules/whr-consolidation/long-term-price.ts");
  assert.match(ltp, /export const LONG_TERM_PRICE_WRITE_ENABLED = false;/, "长期价写接口的开关不是 false");
  const agentRoutes = read("apps/api/src/modules/agent-portal/routes.ts");
  const adminRoutes = read("apps/api/src/modules/admin/routes.ts");
  for (const [name, src] of [["/agent/clients/price", agentRoutes], ["/admin/clients/whr-price", adminRoutes]] as Array<[string, string]>) {
    assert.ok(src.includes("LONG_TERM_PRICE_WRITE_ENABLED"), `${name} 没判开关，关着也能覆盖柜价`);
  }
});
}

main().then(() => {
  console.log(failures === 0 ? "✅ 全部通过" : `❌ 失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((e) => { console.error(e); process.exit(1); });
