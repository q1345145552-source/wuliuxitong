/**
 * 代理端「我的钱包」（2026-11-19，财务系统2 第 13 期）：不连库的部分。
 *
 * ① 解析财务系统2 的返回：约定第 10 节三个样例原样能收；金额是数字 / 时间不带时区 / 代理编号对不上 / hasMore 跟游标对不上 → 不收
 * ② 给页面的字段一个不多：财务多给的字段（内部备注之类）不往下传
 * ③ 金额显示：照字符串原样、负数带「-¥」、变动 0 显示「—」
 * ④ 只看自己的：后端只用登录代理的 agentId，不读页面传上来的编号；密钥不进前端
 * ⑤ 页面：菜单、分区接上；没有「申请提现」按钮；拿不到数据时的话不出现「接口」「密钥」
 * 用法：npm run test:finance2-wallet-source
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { parseBalance, parseLedger, parseWithdrawals } from "../apps/api/src/modules/finance2-wallet/views";
import { readFinance2Remote } from "../apps/api/src/modules/finance2-holds/config";

const ROOT = path.join(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const AG = "cm3agent0003";

let failures = 0;
let passes = 0;
async function test(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passes++;
    console.log(`  ✅ ${label}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ ${label}\n     ${e instanceof Error ? e.message.split("\n").slice(0, 10).join("\n     ") : String(e)}`);
  }
}

/** 约定 10.1 原样 */
const BALANCE = { serverTime: "2026-12-05T10:15:02.123+07:00", agentId: AG, currency: "CNY", pending: "0.00", available: "130.00", withdrawn: "50.00", lastSeq: 4, lastEntryAt: "2026-12-03T16:20:00.000+07:00" };
/** 约定 10.2 原样 */
const LEDGER = {
  serverTime: "2026-12-05T10:15:02.123+07:00", agentId: AG,
  items: [
    { seq: 4, kind: "withdrawal", pendingChange: "0.00", availableChange: "-50.00", pendingAfter: "0.00", availableAfter: "130.00", waybillNo: null, customerMark: null, billNo: null, withdrawalId: "12", createdAt: "2026-12-03T16:20:00.000+07:00" },
    { seq: 3, kind: "marginReleased", pendingChange: "-180.00", availableChange: "180.00", pendingAfter: "0.00", availableAfter: "180.00", waybillNo: null, customerMark: null, billNo: "B202611-001", withdrawalId: null, createdAt: "2026-12-02T11:05:31.200+07:00" },
    { seq: 2, kind: "marginAccrued", pendingChange: "80.00", availableChange: "0.00", pendingAfter: "180.00", availableAfter: "0.00", waybillNo: "XT2611180002", customerMark: "10086", billNo: "B202611-001", withdrawalId: null, createdAt: "2026-12-01T09:00:00.512+07:00" },
    { seq: 1, kind: "marginAccrued", pendingChange: "100.00", availableChange: "0.00", pendingAfter: "100.00", availableAfter: "0.00", waybillNo: "XT2611180001", customerMark: "10086", billNo: "B202611-001", withdrawalId: null, createdAt: "2026-12-01T09:00:00.498+07:00" },
  ],
  nextCursor: null, hasMore: false,
};
/** 约定 10.3 原样 */
const WITHDRAWALS = {
  serverTime: "2026-12-05T10:15:02.123+07:00", agentId: AG,
  items: [
    { withdrawalId: "13", amount: "30.00", status: "pending", requestedAt: "2026-12-04T14:00:00.000+07:00", decidedAt: null, paidOn: null, voidedAt: null },
    { withdrawalId: "12", amount: "50.00", status: "paid", requestedAt: "2026-12-02T15:00:00.000+07:00", decidedAt: "2026-12-03T09:30:00.000+07:00", paidOn: "2026-12-03", voidedAt: null },
  ],
  nextCursor: null, hasMore: false,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

async function main(): Promise<void> {
  console.log("\n【① 解析财务系统2 的返回】");
  await test("P1 约定 10.1 余额样例原样能收（金额照字符串）", () => {
    const r = parseBalance(BALANCE, AG);
    assert.ok(typeof r !== "string", String(r));
    assert.deepEqual(r, { currency: "CNY", pending: "0.00", available: "130.00", withdrawn: "50.00", lastSeq: 4, lastEntryAt: "2026-12-03T16:20:00.000+07:00", serverTime: "2026-12-05T10:15:02.123+07:00" });
    const empty = parseBalance({ ...BALANCE, lastSeq: 0, lastEntryAt: null, available: "-50.00" }, AG);
    assert.ok(typeof empty !== "string" && empty.available === "-50.00" && empty.lastEntryAt === null, "负数、没流水都能收");
  });
  await test("P2 约定 10.2 流水样例原样能收；种类配中文；不认识的种类照收、写原值", () => {
    const r = parseLedger(LEDGER, AG);
    assert.ok(typeof r !== "string", String(r));
    if (typeof r === "string") return;
    assert.deepEqual(r.items.map((i) => i.kindLabel), ["提现", "转可用", "差价待结算", "差价待结算"]);
    assert.equal(r.hasMore, false);
    const odd = parseLedger({ ...LEDGER, items: [{ ...LEDGER.items[0], kind: "somethingNew" }] }, AG);
    assert.ok(typeof odd !== "string" && odd.items[0].kindLabel === "其他（somethingNew）");
    // 财务系统2 ADR 0163（2026-11-22）：账单减项减掉那部分的差价直接划掉，流水多一种 marginForfeited。
    const forfeit = parseLedger({ ...LEDGER, items: [{ ...LEDGER.items[0], kind: "marginForfeited" }] }, AG);
    assert.ok(typeof forfeit !== "string" && forfeit.items[0].kindLabel === "减项划掉");
  });
  await test("P3 约定 10.3 提现样例原样能收；状态配中文", () => {
    const r = parseWithdrawals(WITHDRAWALS, AG);
    assert.ok(typeof r !== "string", String(r));
    if (typeof r === "string") return;
    assert.deepEqual(r.items.map((i) => i.statusLabel), ["待审批", "已付款"]);
    assert.equal(r.items[1].paidOn, "2026-12-03");
  });
  await test("P4 坏数据一律不收：金额是数字 / 三位小数 / 带千分位、时间不带时区、代理编号对不上、币种不对、hasMore 跟游标对不上", () => {
    const bads: Array<[string, unknown, (b: unknown, a: string) => unknown]> = [
      ["余额是数字", { ...BALANCE, available: 130 }, parseBalance],
      ["三位小数", { ...BALANCE, available: "130.000" }, parseBalance],
      ["千分位", { ...BALANCE, available: "1,130.00" }, parseBalance],
      ["别的代理", { ...BALANCE, agentId: "other" }, parseBalance],
      ["币种", { ...BALANCE, currency: "THB" }, parseBalance],
      ["lastSeq 负数", { ...BALANCE, lastSeq: -1 }, parseBalance],
      ["时间没时区", { ...LEDGER, items: [{ ...LEDGER.items[0], createdAt: "2026-12-03T16:20:00" }] }, parseLedger],
      ["seq 是 0", { ...LEDGER, items: [{ ...LEDGER.items[0], seq: 0 }] }, parseLedger],
      ["变动是数字", { ...LEDGER, items: [{ ...LEDGER.items[0], availableChange: -50 }] }, parseLedger],
      ["hasMore 说有、却没游标", { ...LEDGER, hasMore: true }, parseLedger],
      ["游标有、hasMore 说没有", { ...LEDGER, nextCursor: "abc" }, parseLedger],
      ["流水别的代理", { ...LEDGER, agentId: "other" }, parseLedger],
      ["付款日期带时间", { ...WITHDRAWALS, items: [{ ...WITHDRAWALS.items[1], paidOn: "2026-12-03T00:00:00+07:00" }] }, parseWithdrawals],
      ["金额缺了", { ...WITHDRAWALS, items: [{ ...WITHDRAWALS.items[0], amount: undefined }] }, parseWithdrawals],
      ["审批时间乱写", { ...WITHDRAWALS, items: [{ ...WITHDRAWALS.items[0], decidedAt: "昨天" }] }, parseWithdrawals],
      ["items 不是数组", { ...WITHDRAWALS, items: null }, parseWithdrawals],
    ];
    for (const [name, body, parse] of bads) assert.equal(typeof parse(body, AG), "string", name);
  });

  console.log("\n【② 给页面的字段一个不多】");
  await test("F1 财务多给的字段（内部备注、经手人、客户价……）不往下传", () => {
    const extra = { note: "内部备注XX", operator: "财务小王", clientPrice: "999.00", reason: "驳回原因XX" };
    const b = parseBalance({ ...BALANCE, ...extra }, AG);
    const l = parseLedger({ ...LEDGER, ...extra, items: LEDGER.items.map((i) => ({ ...i, ...extra })) }, AG);
    const w = parseWithdrawals({ ...WITHDRAWALS, ...extra, items: WITHDRAWALS.items.map((i) => ({ ...i, ...extra })) }, AG);
    const text = JSON.stringify([b, l, w]);
    for (const v of Object.values(extra)) assert.ok(!text.includes(v), `漏了 ${v}`);
    for (const k of Object.keys(extra)) assert.ok(!text.includes(`"${k}"`), `漏了字段 ${k}`);
    const views = read("apps/api/src/modules/finance2-wallet/views.ts").replace(/\/\*[^]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/\.\.\.(body|raw|b)\b/.test(views), "不许整个展开财务的返回");
  });

  console.log("\n【③ 金额显示】");
  const ui = read("apps/web/src/components/agent/AgentFinanceWallet.tsx");
  await test("M1 照字符串原样显示：¥130.00、-¥50.00；变动 0 显示「—」、正的带 +；负数标红；不用 Number / toFixed 转", () => {
    // 组件是 React 文件，这里把两个纯函数抠出来跑
    const fnText = ui.slice(ui.indexOf("export function walletMoney"), ui.indexOf("function moneyStyle"));
    const js = fnText.replace(/export /g, "").replace(/\(s: string\): string/g, "(s)");
    // eslint-disable-next-line no-new-func
    const { walletMoney, walletChange } = new Function(`${js}; return { walletMoney, walletChange };`)() as { walletMoney: (s: string) => string; walletChange: (s: string) => string };
    assert.equal(walletMoney("130.00"), "¥130.00");
    assert.equal(walletMoney("-50.00"), "-¥50.00");
    assert.equal(walletChange("0.00"), "—");
    assert.equal(walletChange("80.00"), "+¥80.00");
    assert.equal(walletChange("-180.00"), "-¥180.00");
    assert.match(ui, /s\.startsWith\("-"\) && !\/\^-0\\\.00\$\/\.test\(s\) \? \{ \.\.\.base, color: "var\(--c-red-deep\)" \}/);
    assert.ok(!/Number\(|parseFloat|toFixed/.test(ui), "金额不许转数字");
  });

  console.log("\n【④ 只看自己的、密钥不出后台】");
  await test("S1 后端只用登录代理的 agentId，不读页面传上来的编号；每个接口先 requireAgent", () => {
    const routes = read("apps/api/src/modules/finance2-wallet/routes.ts");
    assert.ok(!/req\.query\.agentId|req\.body/.test(routes));
    assert.equal((routes.match(/requireAgent\(req, res\)/g) ?? []).length, 2, "余额一处 + 两个列表共用一处");
    assert.equal((routes.match(/auth\.agentId/g) ?? []).length, 2);
    assert.match(routes, /new URLSearchParams\(\{ agentId, \.\.\.extra \}\)/, "agentId 放在最前、extra 里不会有 agentId");
    assert.ok(!/agentId/.test(routes.slice(routes.indexOf("limit: String(PAGE_LIMIT)"), routes.indexOf("limit: String(PAGE_LIMIT)") + 80)));
  });
  await test("S2 密钥 / 地址只在后台：前端一个字都不碰；跟扣货名单共用同一把（约定 10.0）、不看扣货开关", () => {
    for (const f of walk(path.join(ROOT, "apps/web/src"))) {
      const t = readFileSync(f, "utf8");
      assert.ok(!t.includes("FINANCE2_HOLDS_SECRET") && !t.includes("FINANCE2_API_BASE") && !t.includes("integrations/logistics"), f);
    }
    const env = { FINANCE2_HOLDS_SECRET: "F1n2Hold-aB3dE5gH7jK9mN1pQ3sT5vXyZ", FINANCE2_API_BASE: "https://caiwu.example.com" } as NodeJS.ProcessEnv;
    assert.equal(readFinance2Remote(env).remote?.apiBase, "https://caiwu.example.com/integrations/logistics/v1", "扣货开关没开也能用");
    assert.equal(readFinance2Remote({ ...env, FINANCE2_HOLDS_SECRET: "short" }).remote, null);
  });

  console.log("\n【⑤ 页面】");
  await test("W1 菜单「我的钱包」→ /agent#my-wallet；分区接上；关着的「集货余额」不受影响", () => {
    const menu = read("apps/web/src/modules/layout/menu-config.ts");
    assert.match(menu, /\{ id: "agent-func-my-wallet", label: "我的钱包", href: "\/agent#my-wallet" \}/);
    assert.match(menu, /\{ id: "agent-func-wallet", label: "集货余额", href: "\/agent#wallet" \}/);
    const page = read("apps/web/src/app/agent/page.tsx");
    assert.match(page, /"rebates", "my-wallet", "me"\] as const/);
    assert.match(page, /\{section === "my-wallet" \? <AgentFinanceWallet \/> : null\}/);
  });
  await test("W2 只能看：没有申请提现 / 提交按钮；不显示客户价、代理价、备注、驳回原因", () => {
    const code = ui.replace(/\/\*[^]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/申请提现|提交|onSubmit|method: "POST"/.test(code));
    assert.ok(!/客户价|代理价|备注|原因/.test(code.replace(/WALLET_STATE_TEXT[^]*?\};/, "")));
    const api = read("apps/web/src/services/agent-api.ts");
    const walletApi = api.slice(api.indexOf("/* ── 我的钱包"));
    assert.ok(!/POST/.test(walletApi));
  });
  await test("W3 拿不到数据时说人话：还没开通 / 还没有钱包记录 / 暂时取不到；不出现「接口」「密钥」「404」", () => {
    const block = ui.slice(ui.indexOf("export const WALLET_STATE_TEXT"), ui.indexOf("type ListState"));
    for (const t of ["钱包还没开通", "还没有钱包记录", "暂时取不到钱包数据"]) assert.ok(block.includes(t), t);
    assert.ok(!/接口|密钥|404|500|HTTP/.test(block));
  });
  await test("W4 后端：拿不到数据统一回 200 + state（页面不弹红色报错）；格式不对打 error 日志", () => {
    const routes = read("apps/api/src/modules/finance2-wallet/routes.ts");
    assert.match(routes, /if \(r\.status === 404\) return \{ state: "notFound" \};/);
    assert.match(routes, /logger\.error\("代理钱包：财务系统返回的格式不对"/);
    assert.match(read("apps/api/src/main.ts"), /registerFinance2WalletRoutes\(app\);/);
  });

  console.log(`\n通过 ${passes}，失败 ${failures}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
