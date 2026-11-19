/**
 * 代理端「我的钱包」：真 PostgreSQL（登录核验要真账号）+ 真 HTTP 服务 + 本进程里的假财务系统2（2026-11-19，第 13 期）。
 *
 * 盯：代理只能看自己的（去问财务时带的是登录代理的编号，页面传别的编号没用）；客户 / 员工 / 管理员 403；
 * 密钥在请求头不在地址里；没配地址密钥 → notConfigured（不去连）；财务 404 → notFound；500 / 超时 / 格式不对 / 密钥不对 → unreachable；
 * 翻页游标原样转、一页 100；财务多给的字段不往下传；停用的代理进不来。
 *
 * 只连测试库：没设 AGENT_PORTAL_TEST_ALLOW_DB=1 一律不跑；没有 DATABASE_URL 打印「跳过」。数据在假公司 zz_f2w_co 下，开跑前、跑完后清干净。
 * 用法：npm run test:finance2-wallet-db
 */
process.env.TZ = "UTC";
process.env.AUTH_SECRET ||= "test-only-fake-secret-not-a-real-key-do-not-use-in-production";
process.env.AGENT_REBATE_SCHEDULER = "off";
process.env.FINANCE2_HOLDS_SCHEDULER = "off";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type Row = Record<string, any>;

const CO = "zz_f2w_co";
const P = "zz_f2w_";
const SECRET = "F2Wallet-aB3dE5gH7jK9mN1pQ3sT5vXyZ1";
const AG1 = `${P}ag1`;
const AG2 = `${P}ag2`;
const AGENT1 = "zz_f2w_agent1";
const AGENT2 = "zz_f2w_agent2";
const CLIENT = "ZZF2WC";
const STAFF = "zz_f2w_staff";
const ADMIN = "zz_f2w_admin";

let failures = 0;
let passes = 0;
async function test(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passes++;
    console.log(`  ✅ ${label}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ ${label}\n     ${e instanceof Error ? e.message.split("\n").slice(0, 12).join("\n     ") : String(e)}`);
  }
}
const captured: string[] = [];
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); original(...args); };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

// ───────── 假财务系统2（约定 10.1～10.3 的样例，按问的代理编号回） ─────────
interface Reply { status: number; body?: unknown; raw?: string; delayMs?: number }
const fake = {
  requests: [] as Array<{ path: string; auth: string | undefined; query: URLSearchParams }>,
  /** 返回 null 用默认（按代理编号回样例） */
  override: null as null | ((path: string, q: URLSearchParams) => Reply | null),
};
function balanceOf(agentId: string): unknown {
  return { serverTime: "2026-12-05T10:15:02.123+07:00", agentId, currency: "CNY", pending: "0.00", available: agentId === AG1 ? "130.00" : "-50.00", withdrawn: "50.00", lastSeq: 4, lastEntryAt: "2026-12-03T16:20:00.000+07:00" };
}
function ledgerOf(agentId: string, cursor: string | null): unknown {
  const item = (seq: number) => ({ seq, kind: "marginAccrued", pendingChange: "100.00", availableChange: "0.00", pendingAfter: "100.00", availableAfter: "0.00", waybillNo: `XT26111800${seq}`, customerMark: "10086", billNo: "B202611-001", withdrawalId: null, createdAt: "2026-12-01T09:00:00.498+07:00", internalNote: "内部备注ZZW" });
  return cursor === "page2"
    ? { serverTime: "2026-12-05T10:15:02.123+07:00", agentId, items: [item(1)], nextCursor: null, hasMore: false }
    : { serverTime: "2026-12-05T10:15:02.123+07:00", agentId, items: [item(3), item(2)], nextCursor: "page2", hasMore: true };
}
function withdrawalsOf(agentId: string): unknown {
  return { serverTime: "2026-12-05T10:15:02.123+07:00", agentId, items: [{ withdrawalId: "12", amount: "50.00", status: "paid", requestedAt: "2026-12-02T15:00:00.000+07:00", decidedAt: "2026-12-03T09:30:00.000+07:00", paidOn: "2026-12-03", voidedAt: null, rejectReason: "驳回原因ZZW" }], nextCursor: null, hasMore: false };
}
async function startFake(): Promise<string> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? "/", "http://x");
    fake.requests.push({ path: u.pathname, auth: req.headers.authorization, query: u.searchParams });
    const agentId = u.searchParams.get("agentId") ?? "";
    let reply: Reply | null = fake.override?.(u.pathname, u.searchParams) ?? null;
    if (!reply) {
      if (req.headers.authorization !== `Bearer ${SECRET}`) reply = { status: 401, body: { error: "unauthorized" } };
      else if (![AG1, AG2].includes(agentId)) reply = { status: 404, body: { error: "not_found", serverTime: "2026-12-05T10:15:02.123+07:00" } };
      else if (u.pathname === "/integrations/logistics/v1/agent-wallet") reply = { status: 200, body: balanceOf(agentId) };
      else if (u.pathname === "/integrations/logistics/v1/agent-wallet/ledger") reply = { status: 200, body: ledgerOf(agentId, u.searchParams.get("cursor")) };
      else if (u.pathname === "/integrations/logistics/v1/agent-wallet/withdrawals") reply = { status: 200, body: withdrawalsOf(agentId) };
      else reply = { status: 404, body: {} };
    }
    const r = reply;
    const send = () => { if (!res.destroyed) { res.writeHead(r.status, { "content-type": "application/json" }); res.end(r.raw ?? JSON.stringify(r.body ?? {})); } };
    if (r.delayMs) setTimeout(send, r.delayMs); else send();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：怕连到生产库不跑（确认是测试库再设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  const fakeBase = await startFake();
  process.env.FINANCE2_HOLDS_SECRET = SECRET;
  process.env.FINANCE2_API_BASE = fakeBase;
  delete process.env.FINANCE2_HOLDS_MODE; // 扣货开关关着，钱包照样能用

  const { prisma } = await import("../apps/api/src/db/prisma");
  const { createApp } = await import("../apps/api/src/server");
  const { signAuthToken } = await import("../apps/api/src/modules/auth/token");
  const { hashPassword } = await import("../apps/api/src/modules/auth/crypto-utils");
  const { registerFinance2WalletRoutes } = await import("../apps/api/src/modules/finance2-wallet/routes");
  const db = prisma as any;

  async function cleanup(): Promise<void> {
    await db.user.deleteMany({ where: { companyId: CO } });
    await db.agent.deleteMany({ where: { companyId: CO } });
  }
  await cleanup();
  const pw = hashPassword("Test-pass-Zz123456");
  await db.agent.createMany({ data: [
    { id: AG1, companyId: CO, name: "代理一", priceNormal: 500, priceInspection: 550, priceSensitive: 600 },
    { id: AG2, companyId: CO, name: "代理二", priceNormal: 500, priceInspection: 550, priceSensitive: 600 },
  ] });
  const user = (id: string, role: string, agentId: string | null = null) => ({ id, companyId: CO, role, name: id, phone: "0800000000", status: "active", agentId, passwordHash: pw });
  await db.user.createMany({ data: [user(AGENT1, "agent", AG1), user(AGENT2, "agent", AG2), user(CLIENT, "client", AG1), user(STAFF, "staff"), user(ADMIN, "admin")] });

  const PORT = await freePort();
  const app = createApp();
  registerFinance2WalletRoutes(app);
  await new Promise<void>((resolve) => app.listen(PORT, resolve));
  let ip = 0;
  async function call(p: string, who: string, role: string): Promise<{ status: number; body: Row; text: string }> {
    const token = signAuthToken({ userId: who, companyId: CO, role: role as any, userName: who });
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { authorization: `Bearer ${token}`, "x-real-ip": `10.89.0.${(++ip % 250) + 1}` } });
    const text = await r.text();
    let body: Row = {};
    try { body = JSON.parse(text) as Row; } catch { /* 留空 */ }
    return { status: r.status, body, text };
  }
  const asAgent1 = (p: string) => call(p, AGENT1, "agent");
  const lastQuery = () => fake.requests.at(-1)!;

  try {
    console.log("\n【只看自己的】");
    await test("A1 代理一看余额：去问财务时带的是代理一的编号、密钥在请求头不在地址里；金额照字符串", async () => {
      fake.requests = [];
      const r = await asAgent1("/agent/finance-wallet");
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.data.state, "ok");
      assert.equal(r.body.data.balance.available, "130.00");
      assert.equal(lastQuery().path, "/integrations/logistics/v1/agent-wallet");
      assert.equal(lastQuery().query.get("agentId"), AG1);
      assert.equal(lastQuery().auth, `Bearer ${SECRET}`);
      assert.ok(![...lastQuery().query.values()].some((v) => v.includes(SECRET)));
    });
    await test("A2 页面传别人的编号没用：?agentId=代理二 照样问代理一的", async () => {
      const r = await asAgent1(`/agent/finance-wallet?agentId=${AG2}`);
      assert.equal(r.body.data.balance.available, "130.00");
      assert.equal(lastQuery().query.getAll("agentId").join(","), AG1);
      const l = await asAgent1(`/agent/finance-wallet/ledger?agentId=${AG2}`);
      assert.equal(l.body.data.state, "ok");
      assert.equal(lastQuery().query.getAll("agentId").join(","), AG1);
    });
    await test("A3 代理二看到的是自己的（负数照样给）", async () => {
      const r = await call("/agent/finance-wallet", AGENT2, "agent");
      assert.equal(r.body.data.balance.available, "-50.00");
      assert.equal(lastQuery().query.get("agentId"), AG2);
    });
    await test("A4 客户（哪怕是代理名下的）/ 员工 / 管理员 一律 403，不去问财务", async () => {
      fake.requests = [];
      for (const [who, role] of [[CLIENT, "client"], [STAFF, "staff"], [ADMIN, "admin"]] as const) {
        for (const p of ["/agent/finance-wallet", "/agent/finance-wallet/ledger", "/agent/finance-wallet/withdrawals"]) {
          const r = await call(p, who, role);
          assert.equal(r.status, 403, `${role} ${p}: ${r.text}`);
        }
      }
      assert.equal(fake.requests.length, 0);
    });
    await test("A5 代理账号停用：进不来", async () => {
      await db.user.update({ where: { id: AGENT2 }, data: { status: "disabled" } });
      try {
        const r = await call("/agent/finance-wallet", AGENT2, "agent");
        assert.ok(r.status === 401 || r.status === 403, r.text);
      } finally {
        await db.user.update({ where: { id: AGENT2 }, data: { status: "active" } });
      }
    });

    console.log("\n【流水、提现记录】");
    await test("L1 流水一页 100、游标原样转；财务多给的内部备注不往下传", async () => {
      const r = await asAgent1("/agent/finance-wallet/ledger");
      assert.equal(r.body.data.state, "ok");
      assert.deepEqual(r.body.data.page.items.map((i: Row) => i.seq), [3, 2]);
      assert.equal(r.body.data.page.hasMore, true);
      assert.equal(r.body.data.page.nextCursor, "page2");
      assert.equal(lastQuery().query.get("limit"), "100");
      assert.ok(!r.text.includes("内部备注ZZW") && !r.text.includes("internalNote"));
      const r2 = await asAgent1("/agent/finance-wallet/ledger?cursor=page2");
      assert.equal(lastQuery().query.get("cursor"), "page2");
      assert.deepEqual(r2.body.data.page.items.map((i: Row) => i.seq), [1]);
      assert.equal(r2.body.data.page.hasMore, false);
    });
    await test("L2 提现记录：状态配中文；驳回原因之类多给的字段不往下传", async () => {
      const r = await asAgent1("/agent/finance-wallet/withdrawals");
      assert.equal(r.body.data.page.items[0].statusLabel, "已付款");
      assert.ok(!r.text.includes("驳回原因ZZW") && !r.text.includes("rejectReason"));
    });
    await test("L3 游标带控制字符 / 太长：400，不转给财务", async () => {
      fake.requests = [];
      const r = await asAgent1(`/agent/finance-wallet/ledger?cursor=${encodeURIComponent("a\nb")}`);
      assert.equal(r.status, 400);
      const r2 = await asAgent1(`/agent/finance-wallet/withdrawals?cursor=${"x".repeat(600)}`);
      assert.equal(r2.status, 400);
      assert.equal(fake.requests.length, 0);
    });

    console.log("\n【拿不到数据时】");
    await test("N1 财务那边还没有这个代理（404）→ notFound", async () => {
      fake.override = () => ({ status: 404, body: { error: "not_found", serverTime: "2026-12-05T10:15:02.123+07:00" } });
      try {
        for (const p of ["/agent/finance-wallet", "/agent/finance-wallet/ledger", "/agent/finance-wallet/withdrawals"]) {
          const r = await asAgent1(p);
          assert.equal(r.status, 200);
          assert.deepEqual(r.body.data, { state: "notFound" }, p);
        }
      } finally { fake.override = null; }
    });
    await test("N2 财务 500 / 密钥不对 401 / 回的格式不对 / 回的是别的代理 / 超时 → unreachable（200，页面说人话）", async () => {
      const cases: Array<(p: string, q: URLSearchParams) => Reply> = [
        () => ({ status: 500, body: {} }),
        () => ({ status: 401, body: {} }),
        () => ({ status: 200, raw: "<html>" }),
        (_p, q) => ({ status: 200, body: { ...(balanceOf(q.get("agentId")!) as Row), available: 130 } }),
        () => ({ status: 200, body: balanceOf(AG2) }),
      ];
      try {
        for (const c of cases) {
          fake.override = c;
          const r = await asAgent1("/agent/finance-wallet");
          assert.equal(r.status, 200, r.text);
          assert.deepEqual(r.body.data, { state: "unreachable" });
        }
      } finally { fake.override = null; }
      assert.ok(captured.some((l) => l.includes("代理钱包：财务系统返回的格式不对")));
    });
    await test("N3 财务 10 秒不回：按时断开回 unreachable", async () => {
      fake.override = (_p, q) => ({ status: 200, body: balanceOf(q.get("agentId")!), delayMs: 12_000 });
      try {
        const t0 = Date.now();
        const r = await asAgent1("/agent/finance-wallet");
        assert.deepEqual(r.body.data, { state: "unreachable" });
        assert.ok(Date.now() - t0 < 11_500);
      } finally { fake.override = null; }
    });
    await test("N4 没配地址 / 密钥（或配错）→ notConfigured，不去连财务；日志里不打密钥", async () => {
      for (const [k, v] of [["FINANCE2_API_BASE", undefined], ["FINANCE2_HOLDS_SECRET", undefined], ["FINANCE2_HOLDS_SECRET", "short"]] as const) {
        const keep = process.env[k];
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
        fake.requests = [];
        try {
          for (const p of ["/agent/finance-wallet", "/agent/finance-wallet/ledger", "/agent/finance-wallet/withdrawals"]) {
            const r = await asAgent1(p);
            assert.deepEqual(r.body.data, { state: "notConfigured" }, `${k}=${v} ${p}`);
          }
          assert.equal(fake.requests.length, 0);
        } finally { process.env[k] = keep; }
      }
      assert.ok(!captured.join("\n").includes(SECRET));
    });
  } finally {
    await cleanup();
    const left = await db.user.count({ where: { companyId: CO } }) + await db.agent.count({ where: { companyId: CO } });
    if (left !== 0) { failures++; console.log(`  ❌ 测试数据没清干净，剩 ${left} 行`); }
    await prisma.$disconnect();
  }
  console.log(`\n通过 ${passes}，失败 ${failures}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
