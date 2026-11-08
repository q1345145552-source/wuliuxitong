/**
 * 管理员工作台「客户管理」按归属筛（2026-11-08 老板：「客户管理那边要加筛选，比如筛选是哪个代理的客户或者我们自己的」）。
 * 不连库：直接跑 modules/admin-clients/agent-filter.ts 的纯函数，再看页面有没有接上。
 * 用法：npx tsx scripts/test-admin-client-filter.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  CLIENT_AGENT_FILTER_ALL,
  clientAgentFilterLabel,
  clientAgentFilterOptions,
  clientAgentFilterValue,
  filterAdminClients,
  matchesClientAgentFilter,
  parseClientAgentFilter,
  type ClientAgentFilter,
} from "../apps/web/src/modules/admin-clients/agent-filter";

let passes = 0;
let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passes++;
    console.log(`✅ ${name}`);
  } catch (e) {
    failures++;
    console.log(`❌ ${name}\n   ${e instanceof Error ? e.message : String(e)}`);
  }
}

const AGENTS = [
  { id: "ag_b", name: "阿明物流", loginId: "aming" },
  { id: "ag_a", name: "曼谷速运", loginId: "bkk" },
];
/** 顺序是接口给的（建号时间倒序），筛完要保持 */
const CLIENTS = [
  { id: "XT-001", name: "张三", companyName: "义乌小商品", phone: "13800000001", email: "a@x.com", agentId: null, agentName: null },
  { id: "AM-002", name: "李四", companyName: null, phone: "0812345678", email: null, agentId: "ag_b", agentName: "阿明物流" },
  { id: "XT-003", name: "王五", companyName: "广州电子", phone: "13800000003", email: undefined, agentId: undefined, agentName: undefined },
  { id: "BK-004", name: "赵六", companyName: "Bangkok Trade", phone: "0899999999", email: "zhao@bk.th", agentId: "ag_a", agentName: "曼谷速运" },
  { id: "AM-005", name: "孙七", companyName: "义乌饰品", phone: "13900000005", email: null, agentId: "ag_b", agentName: "阿明物流" },
  { id: "OLD-006", name: "周八", companyName: null, phone: "0811111111", email: null, agentId: "ag_gone", agentName: "老代理" },
];
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
const self: ClientAgentFilter = { kind: "self" };
const agent = (agentId: string): ClientAgentFilter => ({ kind: "agent", agentId });

check("F1 全部：一个不少、顺序不变", () => {
  assert.deepEqual(ids(filterAdminClients(CLIENTS, "", CLIENT_AGENT_FILTER_ALL)), ids(CLIENTS));
});

check("F2 湘泰自己的客户 = 没挂代理的（agentId 是 null 或没有），跟卡片上「所属代理」那格同一个判断", () => {
  assert.deepEqual(ids(filterAdminClients(CLIENTS, "", self)), ["XT-001", "XT-003"]);
  assert.equal(matchesClientAgentFilter({ id: "x", agentId: "" }, self), true, "空字符串也算没挂");
  assert.equal(matchesClientAgentFilter({ id: "x", agentId: "ag_b" }, self), false);
});

check("F3 某个代理：只留他名下的，顺序不变；别的代理、湘泰自己的都不留", () => {
  assert.deepEqual(ids(filterAdminClients(CLIENTS, "", agent("ag_b"))), ["AM-002", "AM-005"]);
  assert.deepEqual(ids(filterAdminClients(CLIENTS, "", agent("ag_a"))), ["BK-004"]);
  assert.deepEqual(ids(filterAdminClients(CLIENTS, "", agent("ag_none"))), []);
});

check("F4 跟搜索叠着用：先按归属、再按搜索词；搜索规则照旧（五样任一命中、不分大小写、去两头空格）", () => {
  assert.deepEqual(ids(filterAdminClients(CLIENTS, "义乌", CLIENT_AGENT_FILTER_ALL)), ["XT-001", "AM-005"]);
  assert.deepEqual(ids(filterAdminClients(CLIENTS, "义乌", self)), ["XT-001"]);
  assert.deepEqual(ids(filterAdminClients(CLIENTS, "义乌", agent("ag_b"))), ["AM-005"]);
  assert.deepEqual(ids(filterAdminClients(CLIENTS, "  BANGKOK ", CLIENT_AGENT_FILTER_ALL)), ["BK-004"], "公司名、大小写、空格");
  assert.deepEqual(ids(filterAdminClients(CLIENTS, "zhao@", agent("ag_a"))), ["BK-004"], "邮箱");
  assert.deepEqual(ids(filterAdminClients(CLIENTS, "0812", CLIENT_AGENT_FILTER_ALL)), ["AM-002"], "电话");
  assert.deepEqual(ids(filterAdminClients(CLIENTS, "xt-00", CLIENT_AGENT_FILTER_ALL)), ["XT-001", "XT-003"], "账号");
  assert.deepEqual(ids(filterAdminClients(CLIENTS, "张三", agent("ag_b"))), [], "张三是湘泰自己的");
  assert.deepEqual(ids(filterAdminClients(CLIENTS, "   ", self)), ["XT-001", "XT-003"], "只有空格 = 没搜");
});

check("F5 下拉框的值来回转：all / self / agent:<id>；认不出来的当全部；代理 id 带冒号也不丢", () => {
  for (const f of [CLIENT_AGENT_FILTER_ALL, self, agent("ag_b"), agent("weird:id:1")]) {
    assert.deepEqual(parseClientAgentFilter(clientAgentFilterValue(f)), f);
  }
  assert.equal(clientAgentFilterValue(agent("self")), "agent:self", "代理 id 碰巧叫 self 也不会被当成湘泰自己的");
  assert.deepEqual(parseClientAgentFilter("agent:self"), agent("self"));
  for (const v of ["", "agent:", "xxx", "ALL", "Self"]) assert.deepEqual(parseClientAgentFilter(v), CLIENT_AGENT_FILTER_ALL, v);
});

check("F6 下拉里的代理：代理名单按原顺序在前，客户身上挂着、名单里没有的补在后面，不重复；不重名只显示名字", () => {
  assert.deepEqual(clientAgentFilterOptions(AGENTS, CLIENTS, CLIENT_AGENT_FILTER_ALL), [
    { id: "ag_b", label: "阿明物流" },
    { id: "ag_a", label: "曼谷速运" },
    { id: "ag_gone", label: "老代理" },
  ]);
  assert.deepEqual(clientAgentFilterOptions([], CLIENTS, CLIENT_AGENT_FILTER_ALL).map((a) => a.id), ["ag_b", "ag_a", "ag_gone"], "第一次拉代理名单就失败（手上是空名单）照样能按客户身上的代理筛");
  assert.deepEqual(clientAgentFilterOptions([], [{ id: "x", agentId: "ag_x", agentName: null }], CLIENT_AGENT_FILTER_ALL), [{ id: "ag_x", label: "代理" }], "没有名字写「代理」，跟卡片一样");
  assert.deepEqual(clientAgentFilterOptions(AGENTS, [], CLIENT_AGENT_FILTER_ALL).map((a) => a.id), ["ag_b", "ag_a"], "还没有客户的代理也列出来");
});

check("F7 选中的代理两边都找不到了（刚被删）也留一项，下拉框显示的跟实际筛的对得上", () => {
  const opts = clientAgentFilterOptions(AGENTS, CLIENTS, agent("ag_deleted"));
  assert.deepEqual(opts.at(-1), { id: "ag_deleted", label: "已不在名单里的代理" });
  assert.equal(opts.filter((a) => a.id === "ag_deleted").length, 1);
  assert.equal(clientAgentFilterOptions(AGENTS, CLIENTS, agent("ag_b")).filter((a) => a.id === "ag_b").length, 1, "在名单里的不重复加");
});

check("F10 代理重名：同名的几个后面带登录账号，没账号的带编号尾巴；数量那半句跟下拉显示一样；不重名的不带", () => {
  const twins = [
    { id: "ag_1", name: "阿明物流", loginId: "aming" },
    { id: "ag_2", name: "阿明物流", loginId: "aming2" },
    { id: "ag_3", name: "曼谷速运", loginId: "bkk" },
  ];
  const rows = [{ id: "XT-1", agentId: null }, { id: "Z-1", agentId: "cmw7glbox0001nsbn0j0kgpzm", agentName: "阿明物流" }];
  const opts = clientAgentFilterOptions(twins, rows, CLIENT_AGENT_FILTER_ALL);
  assert.deepEqual(opts.filter((o) => ["ag_1", "ag_2", "ag_3"].includes(o.id)), [
    { id: "ag_1", label: "阿明物流（账号 aming）" },
    { id: "ag_2", label: "阿明物流（账号 aming2）" },
    { id: "ag_3", label: "曼谷速运" },
  ]);
  assert.deepEqual(opts.find((o) => o.id === "cmw7glbox0001nsbn0j0kgpzm"), { id: "cmw7glbox0001nsbn0j0kgpzm", label: "阿明物流（编号尾 0kgpzm）" }, "名单里没有、只在客户身上的同名代理带编号尾巴");
  assert.deepEqual(clientAgentFilterOptions([...twins, { id: "ag_4", name: "曼谷速运", loginId: "" }], [], CLIENT_AGENT_FILTER_ALL).filter((o) => o.id === "ag_3" || o.id === "ag_4"), [
    { id: "ag_3", label: "曼谷速运（账号 bkk）" },
    { id: "ag_4", label: "曼谷速运（编号尾 ag_4）" },
  ], "同名里有一个没账号的");
  assert.equal(new Set(opts.map((o) => o.label)).size, opts.length, "下拉里没有两项长得一样");
  assert.equal(clientAgentFilterLabel(agent("ag_2"), opts), "代理「阿明物流（账号 aming2）」的客户");
});

check("F8 列表上方那半句：全部时没有；湘泰自己的；代理带名字", () => {
  const opts = clientAgentFilterOptions(AGENTS, CLIENTS, CLIENT_AGENT_FILTER_ALL);
  assert.equal(clientAgentFilterLabel(CLIENT_AGENT_FILTER_ALL, opts), "");
  assert.equal(clientAgentFilterLabel(self, opts), "湘泰自己的客户");
  assert.equal(clientAgentFilterLabel(agent("ag_a"), opts), "代理「曼谷速运」的客户");
  assert.equal(clientAgentFilterLabel(agent("nope"), opts), "代理「代理」的客户");
});

check("F9 页面接上了：客户管理用这套函数筛；下拉框有全部 / 湘泰自己的 / 各代理，改了马上生效；数量那句和空状态带上归属", () => {
  const page = readFileSync(path.join(__dirname, "../apps/web/src/app/admin/page.tsx"), "utf8");
  const api = readFileSync(path.join(__dirname, "../apps/web/src/services/business-api.ts"), "utf8");
  const clients = page.slice(page.indexOf('<section id="clients"'), page.indexOf("{/* 4. 运单管理 */}"));
  assert.ok(clients.length > 0, "找不到客户管理那段");
  assert.match(page, /filterAdminClients\(clientList, clientSearchQuery, clientAgentFilter\)/);
  assert.match(page, /clientAgentFilterOptions\(agentOptions, clientList, clientAgentFilter\)/);
  assert.ok(!/clientList\.filter\(/.test(page), "不许再另写一套客户筛选");
  assert.match(clients, /aria-label="按归属筛客户"/);
  assert.match(clients, /onChange=\{\(e\) => setClientAgentFilter\(parseClientAgentFilter\(e\.target\.value\)\)\}/);
  assert.match(clients, /<option value="all">全部客户<\/option>/);
  assert.match(clients, /<option value="self">湘泰自己的客户<\/option>/);
  assert.match(clients, /clientAgentOptions\.map\(\(a\) => \(/);
  assert.match(clients, /\{filteredClientList\.map\(\(u\) =>/);
  assert.match(clients, /clientSearchQuery \|\| clientAgentLabel \?/);
  assert.match(clients, />代理：\{a\.label\}<\/option>/, "下拉显示用带账号的 label，同名分得清");
  assert.match(clients, /\{clientAgentLabel \? `\$\{clientAgentLabel\}里` : ""\}搜「\{clientSearchQuery\}」找到/, "又筛又搜：「代理「X」的客户里搜「Y」找到 N 个客户」");
  assert.match(clients, /\{clientAgentLabel\}：<strong/, "只筛：「代理「X」的客户：N 个」");
  assert.match(clients, /`\$\{clientAgentLabel\}一个都没有，把归属选回「全部客户」看全部。`/, "只筛筛空了的提示");
  assert.match(clients, /或者点「清空」\$\{clientAgentLabel \? "、把归属选回「全部客户」" : ""\}看全部/, "又筛又搜筛空了的提示");
  // 代理名单拉失败不许用空名单盖掉上一次的（Codex 审查）
  assert.match(page, /if \(agents\) setAgentOptions\(agents\);/);
  assert.ok(!/setAgentOptions\(agents \?\? \[\]\)|setAgentOptions\(agents\);\s*$/m.test(page.replace(/if \(agents\) setAgentOptions\(agents\);/g, "")), "别处不许无条件写代理名单");
  const fetchAgents = api.slice(api.indexOf("export async function fetchAgentOptions"), api.indexOf("export async function fetchAgentOptions") + 600);
  assert.match(fetchAgents, /Promise<AgentOption\[\] \| null>/);
  assert.match(fetchAgents, /catch \{\s*return null;\s*\}/, "出错返回 null，跟「一个代理都没有」分开");
  assert.match(fetchAgents, /loginId: a\.loginId \?\? ""/, "带上登录账号，同名时区分");
});

check("F11 在页面上筛的前提：客户名单接口一次全给、没有分页（CLAUDE.md #19：只拿一页回来在前端筛会漏）", () => {
  const routes = readFileSync(path.join(__dirname, "../apps/api/src/modules/admin/routes.ts"), "utf8");
  const start = routes.indexOf('app.get("/admin/users"');
  const handler = routes.slice(start, routes.indexOf("app.", start + 30));
  assert.ok(start >= 0 && handler.length > 0, "找不到 GET /admin/users");
  const at = handler.indexOf("where: { companyId: auth.companyId, role }");
  assert.ok(at >= 0, "找不到按角色查的那段（写法变了就来这里改，别让检查空转）");
  const clientQuery = handler.slice(at);
  assert.ok(clientQuery.indexOf("ok(res") > 0, "找不到这段的结尾");
  assert.ok(!/\btake\s*:|\bskip\s*:|pageSize|cursor\s*:/.test(clientQuery.slice(0, clientQuery.indexOf("ok(res"))), "客户名单接口加了分页的话，页面上的筛选就会漏人，要改成后端筛");
  const fetchClients = readFileSync(path.join(__dirname, "../apps/web/src/services/business-api.ts"), "utf8");
  assert.match(fetchClients, /fetch\(`\$\{apiBaseUrl\(\)\}\/admin\/users\?role=client`/, "页面拉客户名单不带分页参数");
});

console.log(`\n通过 ${passes}，失败 ${failures}`);
if (failures > 0) process.exit(1);
