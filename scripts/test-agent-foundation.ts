/**
 * 代理账号地基自测（2026-09-16，A2）。不连数据库、不连外网 —— prisma 换成内存桩。
 *
 * 盯住这几件事（规格 docs/交接文档-附件-代理账号确认单/实现规格.md 2.1，该目录不进 git）：
 *  1. 令牌角色硬闸认 agent，不认得的角色一律当没登录
 *  2. session-guard：库里角色和令牌不一致判失效；agentId 从库里现读带回
 *  3. **真起一个 HTTP 服务**走完整请求管线：agentId 进 req.auth、统一闸 403
 *     （代理的客户碰普通版集货 / AI；代理本人碰 /agent、/auth 以外的路径）、改归属当场生效
 *  4. requireAgent / listAgentClientIds / agentOwnsClient 判空不查库
 *  5. computeRebate 算例：三档混装、分四舍五入边界（浮点会差一分的那种）、Decimal 输入
 *  6. setClientWhrPrice：低于代理价被拒且什么都没写；只重算未付款；已发运的柜不动；
 *     锁序【客户价锁 → 代理行 → 计划（排序）→ 写】；锁后重读状态（锁之前被发运的柜跳过）
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";
process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "zz_test_secret_for_agent_foundation_only";
process.env.BIND_HOST = "127.0.0.1";

import assert from "node:assert/strict";
import net from "node:net";

type Row = Record<string, any>;

const failures: string[] = [];
let total = 0;
async function check(name: string, body: () => Promise<void> | void): Promise<void> {
  total += 1;
  try {
    await body();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(name);
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.log(`  ❌ ${name}\n     ${message.split("\n").slice(0, 6).join("\n     ")}`);
  }
}

/* ────────────────────────── 内存桩 ────────────────────────── */

const db = {
  users: [] as Row[],
  agents: [] as Row[],
  plans: [] as Row[],
  planCustomers: [] as Row[],
  prealerts: [] as Row[],
  prices: [] as Row[],
};
/** 按发生顺序记下每一次加锁 / 写库，用来断言锁序 */
let events: string[] = [];
/** 模拟「候选查询之后、加锁之前，柜被别人发运了」：planId → 加锁时读到的状态 */
let statusOnLock: Record<string, string> = {};
let dbCalls = 0;

const sqlText = (strings: TemplateStringsArray): string => strings.join("?").replace(/\s+/g, " ").trim();

function pick(row: Row | undefined, select?: Row): Row | null {
  if (!row) return null;
  if (!select) return { ...row };
  const out: Row = {};
  for (const key of Object.keys(select)) out[key] = row[key];
  return out;
}

const stub: Row = {
  user: {
    async findUnique({ where, select }: Row) {
      dbCalls += 1;
      return pick(db.users.find((u) => u.id === where.id), select);
    },
    async findFirst({ where, select }: Row) {
      dbCalls += 1;
      const row = db.users.find(
        (u) =>
          u.id === where.id &&
          (where.companyId === undefined || u.companyId === where.companyId) &&
          (where.role === undefined || u.role === where.role) &&
          (where.agentId === undefined || u.agentId === where.agentId),
      );
      return pick(row, select);
    },
    async findMany({ where, select }: Row) {
      dbCalls += 1;
      return db.users
        .filter((u) => u.agentId === where.agentId && u.companyId === where.companyId && u.role === where.role)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((u) => pick(u, select));
    },
  },
  agent: {
    async findUnique({ where, select }: Row) {
      dbCalls += 1;
      return pick(db.agents.find((a) => a.id === where.id), select);
    },
  },
  clientWhrPrice: {
    async findUnique({ where, select }: Row) {
      dbCalls += 1;
      return pick(db.prices.find((p) => p.clientId === where.clientId), select);
    },
    async upsert({ where, create, update }: Row) {
      dbCalls += 1;
      events.push(`write:client_whr_prices`);
      const hit = db.prices.find((p) => p.clientId === where.clientId);
      if (hit) Object.assign(hit, update);
      else db.prices.push({ ...create });
    },
  },
  whrConsolidationPlanCustomer: {
    async findMany({ where, select, orderBy }: Row) {
      dbCalls += 1;
      let rows = db.planCustomers.filter(
        (pc) => pc.clientId === where.clientId && (where.companyId === undefined || pc.companyId === where.companyId),
      );
      if (where.plan?.status?.in) {
        rows = rows.filter((pc) => where.plan.status.in.includes(db.plans.find((p) => p.id === pc.planId)?.status));
      }
      if (where.planId?.in) rows = rows.filter((pc) => where.planId.in.includes(pc.planId));
      if (orderBy?.planId === "asc") rows = [...rows].sort((a, b) => (a.planId < b.planId ? -1 : 1));
      return rows.map((r) => pick(r, select));
    },
    async update({ where, data }: Row) {
      dbCalls += 1;
      events.push(`write:plan_customers:${where.id}`);
      const row = db.planCustomers.find((pc) => pc.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
  },
  whrConsolidationPrealert: {
    async findUnique({ where }: Row) {
      dbCalls += 1;
      const pa = db.prealerts.find((p) => p.id === where.id);
      if (!pa) return null;
      const pc = db.planCustomers.find((c) => c.id === pa.customerId)!;
      return {
        status: pa.status,
        planCustomer: {
          unitPriceNormal: pc.unitPriceNormal,
          unitPriceInspection: pc.unitPriceInspection,
          unitPriceSensitive: pc.unitPriceSensitive,
        },
        items: pa.items,
      };
    },
    async findMany({ where, select }: Row) {
      dbCalls += 1;
      let rows = db.prealerts.filter((p) => p.customerId === where.customerId);
      if (where.status?.in) rows = rows.filter((p) => where.status.in.includes(p.status));
      if (where.status?.not) rows = rows.filter((p) => p.status !== where.status.not);
      return rows.map((p) => (select?.items ? { totalFee: p.totalFee, items: p.items } : { id: p.id }));
    },
    async update({ where, data }: Row) {
      dbCalls += 1;
      events.push(`write:prealert:${where.id}`);
      Object.assign(db.prealerts.find((p) => p.id === where.id)!, data);
    },
  },
  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    dbCalls += 1;
    const sql = sqlText(strings);
    if (sql.includes("pg_advisory_xact_lock(83020")) events.push(`lock:client_price:${values[0]}`);
    else events.push(`exec:${sql}`);
    return 0;
  },
  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    dbCalls += 1;
    const sql = sqlText(strings);
    if (/FROM agents WHERE/.test(sql) && /FOR SHARE/.test(sql)) {
      events.push(`lock:agent:${values[0]}`);
      const a = db.agents.find((x) => x.id === values[0] && x.companyId === values[1]);
      return a ? [{ price_normal: a.priceNormal, price_inspection: a.priceInspection, price_sensitive: a.priceSensitive }] : [];
    }
    if (/FROM whr_consolidation_plans WHERE/.test(sql) && /FOR UPDATE/.test(sql)) {
      const planId = String(values[0]);
      events.push(`lock:plan:${planId}`);
      const p = db.plans.find((x) => x.id === planId);
      if (!p) return [];
      return [{ status: statusOnLock[planId] ?? p.status }];
    }
    throw new Error(`桩没实现这条 SQL：${sql}`);
  },
  lastTransactionOptions: null as Row | null,
  async $transaction(fn: (tx: unknown) => Promise<unknown>, options?: Row) {
    stub.lastTransactionOptions = options ?? null;
    return fn(stub);
  },
};
(globalThis as any).__prisma = stub;

/* ────────────────────────── 夹具 ────────────────────────── */

function resetFixtures(): void {
  events = [];
  statusOnLock = {};
  db.users = [
    { id: "zz_agent_login", companyId: "c1", role: "agent", status: "active", passwordHash: "h_agent", agentId: "zz_agent1" },
    { id: "zz_agent_orphan", companyId: "c1", role: "agent", status: "active", passwordHash: "h_orphan", agentId: null },
    { id: "zz_c_agent", companyId: "c1", role: "client", status: "active", passwordHash: "h_ca", agentId: "zz_agent1" },
    { id: "zz_c_xt", companyId: "c1", role: "client", status: "active", passwordHash: "h_cx", agentId: null },
    { id: "zz_admin", companyId: "c1", role: "admin", status: "active", passwordHash: "h_admin", agentId: null },
  ];
  db.agents = [{ id: "zz_agent1", companyId: "c1", priceNormal: 500, priceInspection: 600, priceSensitive: 700 }];
  // 故意让候选顺序是 P2 在前，锁的时候必须按排序 P1 → P2
  db.plans = [
    { id: "zz_P2", status: "collecting" },
    { id: "zz_P1", status: "loading" },
    { id: "zz_P3", status: "shipped" },
  ];
  const oldPrices = { unitPriceNormal: 800, unitPriceInspection: 800, unitPriceSensitive: 800 };
  db.planCustomers = [
    { id: "zz_pc2", planId: "zz_P2", companyId: "c1", clientId: "zz_c_agent", ...oldPrices, totalFee: 0 },
    { id: "zz_pc1", planId: "zz_P1", companyId: "c1", clientId: "zz_c_agent", ...oldPrices, totalFee: 0 },
    { id: "zz_pc3", planId: "zz_P3", companyId: "c1", clientId: "zz_c_agent", ...oldPrices, totalFee: 0 },
  ];
  const items = [
    { cargoType: "normal", volumeM3: 1.5, packageCount: 3 },
    { cargoType: "sensitive", volumeM3: 0.5, packageCount: 1 },
  ];
  db.prealerts = [
    { id: "zz_pa_unpaid", customerId: "zz_pc1", status: "received_pending_payment", totalFee: 1600, items },
    { id: "zz_pa_paid", customerId: "zz_pc1", status: "paid", totalFee: 999, items },
    { id: "zz_pa_cancel", customerId: "zz_pc1", status: "cancelled", totalFee: 0, items },
    { id: "zz_pa_p2", customerId: "zz_pc2", status: "pending", totalFee: 0, items: [{ cargoType: "inspection", volumeM3: 2, packageCount: 1 }] },
    { id: "zz_pa_p3", customerId: "zz_pc3", status: "shipped", totalFee: 1600, items },
  ];
  db.prices = [];
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/* ────────────────────────── 开测 ────────────────────────── */

async function main(): Promise<void> {
  resetFixtures();
  const { signAuthToken, verifyAuthToken } = await import("../apps/api/src/modules/auth/token");
  const { isSessionStillValid } = await import("../apps/api/src/modules/auth/session-guard");
  const scope = await import("../apps/api/src/modules/core/agent-scope");
  const { createApp } = await import("../apps/api/src/server");
  const { ok } = await import("../apps/api/src/modules/core/http-utils");
  const { computeRebate } = await import("../apps/api/src/modules/whr-consolidation/rebate");
  const ltp = await import("../apps/api/src/modules/whr-consolidation/long-term-price");
  const { isBusinessError } = await import("../apps/api/src/modules/core/business-error");
  const { Prisma } = await import("@prisma/client");

  const tokenFor = (userId: string, role: string): string => {
    const u = db.users.find((x) => x.id === userId)!;
    return signAuthToken({ userId, companyId: "c1", role: role as any, userName: userId, passwordHash: u.passwordHash });
  };

  console.log("代理账号地基");

  await check("1) 令牌硬闸：agent 签出来能验过；不认得的角色（superuser）验不过", () => {
    const good = verifyAuthToken(tokenFor("zz_agent_login", "agent"));
    assert.equal(good?.role, "agent");
    const bad = signAuthToken({ userId: "zz_admin", companyId: "c1", role: "superuser" as any, userName: "x" });
    assert.equal(verifyAuthToken(bad), null, "不认得的角色必须当没登录");
  });

  await check("2) session-guard：库里角色和令牌不一致 → 失效；一致 → 带回库里现读的 agentId", async () => {
    const payload = verifyAuthToken(tokenFor("zz_c_agent", "agent"))!; // 令牌说 agent，库里是 client
    const r1 = await isSessionStillValid(payload);
    assert.equal(r1.ok, false);
    assert.match((r1 as { reason: string }).reason, /角色/);
    const r2 = await isSessionStillValid(verifyAuthToken(tokenFor("zz_c_agent", "client"))!);
    assert.deepEqual(r2, { ok: true, agentId: "zz_agent1" });
    const r3 = await isSessionStillValid(verifyAuthToken(tokenFor("zz_c_xt", "client"))!);
    assert.deepEqual(r3, { ok: true, agentId: null });
  });

  await check("3) 统一闸纯函数：前缀按路径段匹配，别的角色不受影响", () => {
    const agentClient = { role: "client" as const, agentId: "zz_agent1" };
    const xtClient = { role: "client" as const, agentId: null };
    const agent = { role: "agent" as const, agentId: "zz_agent1" };
    assert.equal(scope.agentGateRejection(agentClient, "/client/ai/chat"), "该功能暂未开放");
    assert.equal(scope.agentGateRejection(agentClient, "/client/ai"), "该功能暂未开放");
    assert.equal(scope.agentGateRejection(agentClient, "/client/consolidation/tasks"), "该功能暂未开放");
    assert.equal(scope.agentGateRejection(agentClient, "/client/whr-consolidation/plans"), null, "仓库版集货不许误拦");
    assert.equal(scope.agentGateRejection(agentClient, "/client/aircraft"), null, "不是 /client/ai 这一段");
    assert.equal(scope.agentGateRejection(agentClient, "/client/orders"), null);
    assert.equal(scope.agentGateRejection(xtClient, "/client/ai/chat"), null, "湘泰自己的客户照旧");
    assert.equal(scope.agentGateRejection(agent, "/agent/me"), null);
    assert.equal(scope.agentGateRejection(agent, "/auth/logout"), null);
    assert.ok(scope.agentGateRejection(agent, "/client/orders"));
    assert.ok(scope.agentGateRejection(agent, "/staff/shipments"));
    assert.ok(scope.agentGateRejection(agent, "/admin/users"));
    assert.ok(scope.agentGateRejection(agent, "/agentx"), "/agentx 不是 /agent 这一段");
    assert.equal(scope.agentGateRejection({ role: "admin", agentId: null }, "/client/ai/chat"), null);
    assert.equal(scope.agentGateRejection(undefined, "/client/ai/chat"), null, "没登录交给各接口自己回 401");
  });

  // ── 真起 HTTP 服务：走 server.ts 的完整管线（验签 → session-guard → 统一闸 → 路由）──
  const app = createApp();
  const echo = (req: any, res: any): void => ok(res, { auth: req.auth ?? null });
  for (const p of ["/client/ai/chat", "/client/consolidation/tasks", "/client/orders", "/client/whr-consolidation/plans", "/agent/me", "/admin/users", "/auth/logout"]) {
    app.get(p, echo);
  }
  const port = await freePort();
  await new Promise<void>((resolve) => app.listen(port, resolve));
  const call = async (path: string, token?: string): Promise<{ status: number; body: any }> => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: r.status, body: await r.json() };
  };

  await check("4) 真请求：代理的客户打普通版集货 / AI → 403「该功能暂未开放」；仓库版、运单照常且 auth.agentId 带上", async () => {
    const t = tokenFor("zz_c_agent", "client");
    for (const p of ["/client/ai/chat", "/client/consolidation/tasks"]) {
      const r = await call(p, t);
      assert.equal(r.status, 403, p);
      assert.equal(r.body.message, "该功能暂未开放");
    }
    for (const p of ["/client/orders", "/client/whr-consolidation/plans"]) {
      const r = await call(p, t);
      assert.equal(r.status, 200, p);
      assert.equal(r.body.data.auth.agentId, "zz_agent1");
      assert.equal(r.body.data.auth.role, "client");
    }
  });

  await check("5) 真请求：湘泰客户、管理员 agentId 为 null，AI 照常放行", async () => {
    const r = await call("/client/ai/chat", tokenFor("zz_c_xt", "client"));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.auth.agentId, null);
    const a = await call("/admin/users", tokenFor("zz_admin", "admin"));
    assert.equal(a.status, 200);
    assert.equal(a.body.data.auth.agentId, null);
  });

  await check("6) 真请求：代理令牌只许 /agent、/auth；打 /admin /client 一律 403", async () => {
    const t = tokenFor("zz_agent_login", "agent");
    const me = await call("/agent/me", t);
    assert.equal(me.status, 200);
    assert.deepEqual(
      { role: me.body.data.auth.role, agentId: me.body.data.auth.agentId },
      { role: "agent", agentId: "zz_agent1" },
    );
    assert.equal((await call("/auth/logout", t)).status, 200);
    assert.equal((await call("/admin/users", t)).status, 403);
    assert.equal((await call("/client/orders", t)).status, 403);
    assert.equal((await call("/client/ai/chat", t)).status, 403);
  });

  await check("7) 真请求：令牌角色和库里不一致 → 当没登录（auth 为空）；改归属当场生效", async () => {
    const forged = await call("/admin/users", tokenFor("zz_c_xt", "admin")); // 库里是 client
    assert.equal(forged.status, 200);
    assert.equal(forged.body.data.auth, null, "角色对不上必须当没登录");
    const t = tokenFor("zz_c_agent", "client");
    assert.equal((await call("/client/ai/chat", t)).status, 403);
    db.users.find((u) => u.id === "zz_c_agent")!.agentId = null; // 同一张令牌，库里改归属
    assert.equal((await call("/client/ai/chat", t)).status, 200, "agentId 每次现读，不等令牌过期");
    db.users.find((u) => u.id === "zz_c_agent")!.agentId = "zz_agent1";
  });

  await check("8) requireAgent：agentId 为空的 agent、客户、没登录都 403/401；正常代理放行", () => {
    const mkRes = () => {
      const r: any = { code: 200, body: null, status(c: number) { r.code = c; return r; }, json(b: unknown) { r.body = b; } };
      return r;
    };
    const base = { method: "GET", path: "/agent/me", query: {}, headers: {} };
    let res = mkRes();
    assert.equal(scope.requireAgent({ ...base, auth: { userId: "zz_agent_orphan", companyId: "c1", role: "agent", name: "", agentId: null } }, res), null);
    assert.equal(res.code, 403);
    res = mkRes();
    assert.equal(scope.requireAgent({ ...base, auth: { userId: "zz_c_agent", companyId: "c1", role: "client", name: "", agentId: "zz_agent1" } }, res), null);
    assert.equal(res.code, 403, "代理的客户也不是代理");
    res = mkRes();
    assert.equal(scope.requireAgent({ ...base }, res), null);
    assert.equal(res.code, 401);
    res = mkRes();
    const got = scope.requireAgent({ ...base, auth: { userId: "zz_agent_login", companyId: "c1", role: "agent", name: "", agentId: "zz_agent1" } }, res);
    assert.equal(got?.agentId, "zz_agent1");
  });

  await check("9) 名下范围：参数为空不查库直接空；只数自己名下 client；非代理身份一律 false", async () => {
    const before = dbCalls;
    assert.deepEqual(await scope.listAgentClientIds("", "c1"), []);
    assert.deepEqual(await scope.listAgentClientIds("zz_agent1", ""), []);
    assert.equal(await scope.agentOwnsClient({ role: "admin", agentId: null, companyId: "c1" }, "zz_c_agent"), false);
    assert.equal(await scope.agentOwnsClient({ role: "agent", agentId: null, companyId: "c1" }, "zz_c_agent"), false);
    assert.equal(await scope.agentOwnsClient({ role: "agent", agentId: "zz_agent1", companyId: "c1" }, ""), false);
    assert.equal(dbCalls, before, "判空的几种都不该碰数据库（where 里 undefined = 不加条件）");
    assert.deepEqual(await scope.listAgentClientIds("zz_agent1", "c1"), ["zz_c_agent"], "agent 登录号自己不算客户");
    assert.equal(await scope.agentOwnsClient({ role: "agent", agentId: "zz_agent1", companyId: "c1" }, "zz_c_agent"), true);
    assert.equal(await scope.agentOwnsClient({ role: "agent", agentId: "zz_agent1", companyId: "c1" }, "zz_c_xt"), false);
    assert.equal(await scope.agentOwnsClient({ role: "agent", agentId: "zz_agent1", companyId: "c2" }, "zz_c_agent"), false, "跨公司");
  });

  await check("10) computeRebate：10 方普货 × (600−500) = 1000", () => {
    const r = computeRebate([{ cargoType: "normal", volumeM3: 10 }], { normal: 600, inspection: 0, sensitive: 0 }, { normal: 500, inspection: 0, sensitive: 0 });
    assert.equal(r.rebateAmount, 1000);
    assert.deepEqual(r.volumes, { normal: 10, inspection: 0, sensitive: 0 });
  });

  await check("11) computeRebate：三档混装逐档算，方数回 3 位", () => {
    const r = computeRebate(
      [
        { cargoType: "normal", volumeM3: 1.234567 }, // × 100 = 123.4567
        { cargoType: "inspection", volumeM3: 0.5 }, // × 50  = 25
        { cargoType: "sensitive", volumeM3: 0.333333 }, // × 100 = 33.3333
        { cargoType: null, volumeM3: null }, // 没量尺寸 → 0，按普货
      ],
      { normal: 600, inspection: 700, sensitive: 800 },
      { normal: 500, inspection: 650, sensitive: 700 },
    );
    assert.equal(r.rebateAmount, 181.79);
    assert.deepEqual(r.volumes, { normal: 1.235, inspection: 0.5, sensitive: 0.333 });
  });

  await check("12) computeRebate：分的四舍五入不吃浮点误差（1.005 元要进成 1.01，浮点会算成 1.00）", () => {
    assert.equal(Math.round(1.005 * 100) / 100, 1, "前提：浮点确实会算错，否则这条测不出东西");
    const r = computeRebate([{ cargoType: "normal", volumeM3: 1.005 }], { normal: 501, inspection: 0, sensitive: 0 }, { normal: 500, inspection: 0, sensitive: 0 });
    assert.equal(r.rebateAmount, 1.01);
    const r2 = computeRebate([{ cargoType: "normal", volumeM3: 0.004999 }], { normal: 501, inspection: 0, sensitive: 0 }, { normal: 500, inspection: 0, sensitive: 0 });
    assert.equal(r2.rebateAmount, 0);
  });

  await check("13) computeRebate：Prisma Decimal / 字符串输入照算，未知货型按普货；脏数据抛错不当 0", () => {
    const r = computeRebate(
      [
        { cargoType: "weird", volumeM3: new Prisma.Decimal("2.500000") },
        { cargoType: "sensitive", volumeM3: "1" },
      ],
      { normal: new Prisma.Decimal("550.00"), inspection: "600", sensitive: "900.50" },
      { normal: "500.00", inspection: 600, sensitive: new Prisma.Decimal("700") },
    );
    assert.equal(r.rebateAmount, 2.5 * 50 + 200.5);
    assert.throws(() => computeRebate([{ cargoType: "normal", volumeM3: "abc" }], { normal: 1, inspection: 1, sensitive: 1 }, { normal: 1, inspection: 1, sensitive: 1 }));
  });

  const actor = { userId: "zz_agent_login", role: "agent" };
  const expectBusiness = async (fn: () => Promise<unknown>, re: RegExp, status?: number): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      assert.ok(isBusinessError(e), `应抛 BusinessError，实际：${String(e)}`);
      assert.match((e as Error).message, re);
      if (status) assert.equal((e as { httpStatus: number }).httpStatus, status);
      return;
    }
    assert.fail("应该被拦下却放行了");
  };

  await check("14) setClientWhrPrice：代理的客户低于代理价 → 拒，人话列出档位；长期价、柜里价都没动", async () => {
    resetFixtures();
    await expectBusiness(
      () => ltp.setClientWhrPrice({ companyId: "c1", clientId: "zz_c_agent", prices: { normal: 499.99, inspection: 600, sensitive: 650 }, actor }),
      /普货不能低于湘泰给你的价 500 元\/方；敏感货不能低于湘泰给你的价 700 元\/方/,
      400,
    );
    assert.equal(db.prices.length, 0);
    assert.ok(!events.some((e) => e.startsWith("write:") || e.startsWith("lock:plan")), `被拒后不许写、不许锁柜：${events.join(" ")}`);
    assert.equal(db.planCustomers.find((pc) => pc.id === "zz_pc1")!.unitPriceNormal, 800);
  });

  await check("15) setClientWhrPrice：单价不合法（0.001 / 缺档）在碰数据库之前就拦", async () => {
    resetFixtures();
    const before = dbCalls;
    await expectBusiness(() => ltp.setClientWhrPrice({ companyId: "c1", clientId: "zz_c_agent", prices: { normal: 0.001, inspection: 600, sensitive: 700 }, actor }), /普货单价/);
    await expectBusiness(() => ltp.setClientWhrPrice({ companyId: "c1", clientId: "zz_c_agent", prices: { normal: 600, inspection: undefined, sensitive: 700 }, actor }), /商检货单价为必填/);
    assert.equal(dbCalls, before);
  });

  await check("16) setClientWhrPrice：锁序 客户价锁 → 代理行 → 计划按 id 排序 → 才写；只改在跑的柜、只重算没付款的单", async () => {
    resetFixtures();
    const r = await ltp.setClientWhrPrice({ companyId: "c1", clientId: "zz_c_agent", prices: { normal: 550, inspection: 650, sensitive: 750 }, actor });
    assert.equal(stub.lastTransactionOptions?.timeout, 30000, "不传 tx 要自己开事务");
    assert.deepEqual(r, { updatedPlanRows: 2 });
    const locks = events.filter((e) => e.startsWith("lock:"));
    assert.deepEqual(locks, ["lock:client_price:zz_c_agent", "lock:agent:zz_agent1", "lock:plan:zz_P1", "lock:plan:zz_P2"]);
    const firstWrite = events.findIndex((e) => e.startsWith("write:"));
    const lastLock = events.map((e) => e.startsWith("lock:")).lastIndexOf(true);
    assert.ok(firstWrite > lastLock, `第一次写必须在全部锁之后：${events.join(" ")}`);

    assert.deepEqual(db.prices[0], {
      clientId: "zz_c_agent", companyId: "c1", priceNormal: 550, priceInspection: 650, priceSensitive: 750,
      updatedBy: "zz_agent_login", updatedByRole: "agent",
    });
    const pc = (id: string) => db.planCustomers.find((x) => x.id === id)!;
    assert.equal(pc("zz_pc1").unitPriceNormal, 550);
    assert.equal(pc("zz_pc2").unitPriceInspection, 650);
    assert.equal(pc("zz_pc3").unitPriceNormal, 800, "已发运的柜价格不许动");
    const pa = (id: string) => db.prealerts.find((x) => x.id === id)!;
    assert.equal(pa("zz_pa_unpaid").totalFee, 1.5 * 550 + 0.5 * 750, "未付款的单按新价重算");
    assert.equal(pa("zz_pa_paid").totalFee, 999, "已付款的金额不许变（4.14）");
    assert.equal(pa("zz_pa_p3").totalFee, 1600);
    assert.equal(pa("zz_pa_p2").totalFee, 2 * 650);
    assert.equal(pc("zz_pc1").totalFee, 1200 + 999, "客户汇总 = 未取消单金额之和");
  });

  await check("17) setClientWhrPrice：候选查询后、加锁前柜被发运了 → 锁后重读，跳过那个柜", async () => {
    resetFixtures();
    statusOnLock = { zz_P2: "shipped" };
    const r = await ltp.setClientWhrPrice({ companyId: "c1", clientId: "zz_c_agent", prices: { normal: 550, inspection: 650, sensitive: 750 }, actor }, stub);
    assert.deepEqual(r, { updatedPlanRows: 1 });
    assert.equal(db.planCustomers.find((x) => x.id === "zz_pc2")!.unitPriceInspection, 800);
    assert.equal(db.prealerts.find((x) => x.id === "zz_pa_p2")!.totalFee, 0);
  });

  await check("18) setClientWhrPrice：湘泰自己的客户没有代理价下限、不碰代理行；客户不存在 / 别家公司 → 404", async () => {
    resetFixtures();
    const r = await ltp.setClientWhrPrice({ companyId: "c1", clientId: "zz_c_xt", prices: { normal: 100, inspection: 100, sensitive: 100 }, actor: { userId: "zz_admin", role: "admin" } }, stub);
    assert.deepEqual(r, { updatedPlanRows: 0 });
    assert.ok(!events.some((e) => e.startsWith("lock:agent")));
    assert.deepEqual(await ltp.getClientWhrPrice("zz_c_xt", stub), { normal: 100, inspection: 100, sensitive: 100 });
    await expectBusiness(() => ltp.setClientWhrPrice({ companyId: "c2", clientId: "zz_c_xt", prices: { normal: 600, inspection: 600, sensitive: 600 }, actor }, stub), /客户不存在/, 404);
    await expectBusiness(() => ltp.setClientWhrPrice({ companyId: "c1", clientId: "zz_agent_login", prices: { normal: 600, inspection: 600, sensitive: 600 }, actor }, stub), /客户不存在/, 404);
    assert.equal(await ltp.getClientWhrPrice("zz_c_agent", stub), null);
    assert.deepEqual(await ltp.getAgentPrices("zz_agent1", stub), { normal: 500, inspection: 600, sensitive: 700 });
    assert.equal(await ltp.getAgentPrices("", stub), null);
  });

  await check("19) 客户价等于代理价放行（下限是「不低于」不是「高于」）", () => {
    assert.equal(ltp.checkNotBelowAgentPrice({ normal: 500, inspection: 600, sensitive: 700 }, { normal: 500, inspection: 600, sensitive: 700 }), null);
    assert.match(ltp.checkNotBelowAgentPrice({ normal: 500, inspection: 599.99, sensitive: 700 }, { normal: 500, inspection: 600, sensitive: 700 })!, /^商检货不能低于湘泰给你的价 600 元\/方$/);
  });

  console.log(`\n共 ${total} 项，失败 ${failures.length} 项`);
  if (failures.length > 0) {
    console.log("❌ 失败：\n  - " + failures.join("\n  - "));
    process.exit(1);
  }
  console.log("✅ 全部通过");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
