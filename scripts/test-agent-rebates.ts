/**
 * 代理返现单自测（2026-09-16，B2）。不连数据库、不连外网 —— prisma 换成内存桩。
 *
 * 盯住这几件事（需求编号见 docs/交接文档-附件-代理账号确认单/final.md，该目录不进 git）：
 *  1. 月份边界按**北京时间**切：UTC 9 月 30 日 16:00 = 北京 10 月 1 日 0 点，算 10 月
 *  2. 只出已经过完的月份；当月不出；空月份不出空单
 *  3. 重复跑不重复出单（同一个「现在」连跑两次、隔一小时再跑）
 *  4. 出单后才泰国签收的（包括签收时间落在已出单月份的迟到那种）进下一张还没出的单，已出的单一个字不动
 *  5. 明细写全（4.20）：唛头、品名、三档方数、客户价、代理价、返现、6 个时间（装柜/发运取状态日志最早一条）
 *  6. 返现用付款快照；快照返现为空才按快照价现算；负数记 0；快照价不全的不进单
 *  7. 只算 status=thailand_received 且 paid_agent_id=这个代理的；湘泰客户、别的代理、没泰国签收的都不进
 *  8. 锁序：每个代理的事务第一句是 agents FOR UPDATE，之后只插返现单表，不写预报单
 *  9. 「已返」只改状态、时间、操作人，金额和明细不动；重复点不改时间；别家公司 404
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/never?connect_timeout=1";
process.env.NODE_ENV = "test";
process.env.AUTH_SECRET = "zz_test_secret_for_agent_rebates_only";
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
    console.log(`  ❌ ${name}\n     ${message.split("\n").slice(0, 8).join("\n     ")}`);
  }
}

/* ────────────────────────── 内存桩 ────────────────────────── */

let db = {
  users: [] as Row[],
  agents: [] as Row[],
  prealerts: [] as Row[],
  statements: [] as Row[],
  lines: [] as Row[],
};
let events: string[] = [];
let seq = 0;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === undefined) return true;
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if (Array.isArray(v.in)) return v.in.includes(row[k]);
      if ("not" in v) return row[k] !== v.not;
    }
    return row[k] === v;
  });
}
const clone = <T>(v: T): T => structuredClone(v);

const models: Row = {
  user: {
    async findUnique({ where, select }: Row) {
      const u = db.users.find((x) => x.id === where.id);
      if (!u) return null;
      const out: Row = {};
      for (const k of Object.keys(select ?? u)) out[k] = u[k];
      return out;
    },
  },
  agent: {
    async findMany() {
      return [...db.agents].sort((a, b) => (a.id < b.id ? -1 : 1)).map((a) => ({ id: a.id }));
    },
  },
  whrConsolidationPrealert: {
    async findMany({ where }: Row) {
      events.push("read:prealerts");
      return db.prealerts
        .filter((p) => matches(p, where))
        .map((p) => ({
          ...clone(p),
          statusLogs: p.statusLogs.filter((l: Row) => where && ["loading", "shipped"].includes(l.toStatus)),
        }));
    },
  },
  agentRebateStatement: {
    async findMany({ where }: Row) {
      return db.statements.filter((s) => matches(s, where)).map((s) => ({ ...s, agent: { name: db.agents.find((a) => a.id === s.agentId)?.name } }));
    },
    async findFirst({ where }: Row) {
      const s = db.statements.find((x) => matches(x, where));
      return s ? { ...s, agent: { name: db.agents.find((a) => a.id === s.agentId)?.name } } : null;
    },
    async create({ data }: Row) {
      const { lines, ...s } = data;
      if (db.statements.some((x) => x.agentId === s.agentId && x.month === s.month)) {
        throw Object.assign(new Error("unique agent_id,month"), { code: "P2002" });
      }
      const id = `stmt_${++seq}`;
      events.push(`write:agent_rebate_statements:${s.month}`);
      for (const l of lines.create) {
        if (db.lines.some((x) => x.prealertId === l.prealertId)) throw Object.assign(new Error("unique prealert_id"), { code: "P2002" });
      }
      db.statements.push({ id, ...s, paidAt: null, paidBy: null });
      for (const l of lines.create) db.lines.push({ id: `line_${++seq}`, statementId: id, ...l });
      return { id };
    },
    async updateMany({ where, data }: Row) {
      const rows = db.statements.filter((s) => matches(s, where));
      for (const s of rows) Object.assign(s, data);
      return { count: rows.length };
    },
  },
  agentRebateLine: {
    async findMany({ where }: Row) {
      return db.lines.filter((l) => matches(l, where)).map((l) => ({ ...l }));
    },
  },
};

async function queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]> {
  const sql = strings.join("?").replace(/\s+/g, " ").trim();
  if (sql === "SELECT id, company_id FROM agents WHERE id = ? FOR UPDATE") {
    events.push(`lock:agents:${values[0]}`);
    const a = db.agents.find((x) => x.id === values[0]);
    return a ? [{ id: a.id, company_id: a.companyId }] : [];
  }
  throw new Error(`桩没实现这句 SQL：${sql}`);
}

const txEvents: string[][] = [];
const stub: Row = {
  ...models,
  $queryRaw: queryRaw,
  async $transaction(fn: (tx: Row) => Promise<unknown>) {
    const snapshot = clone(db);
    const before = events.length;
    try {
      return await fn({ ...models, $queryRaw: queryRaw });
    } catch (error) {
      db = snapshot;
      throw error;
    } finally {
      txEvents.push(events.slice(before));
    }
  },
  async $connect() {},
};
(globalThis as any).__prisma = stub;

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

/* ────────────────────────── 夹具 ────────────────────────── */

const T = (s: string): Date => new Date(s);

/** 造一票仓库版预报单，默认：代理甲名下、已泰国签收、快照齐全 */
function prealert(id: string, over: Row = {}): Row {
  return {
    id,
    companyId: "c1",
    trackingNo: `WHRP${id}`,
    mark: "MARK-A1",
    status: "thailand_received",
    paidAgentId: "agent_jia",
    createdAt: T("2026-08-01T01:00:00Z"),
    signedAt: T("2026-08-03T02:00:00Z"),
    paymentReviewedAt: T("2026-08-04T03:00:00Z"),
    thailandReceivedAt: T("2026-08-20T04:00:00Z"),
    paidPriceNormal: "520.00",
    paidPriceInspection: "600.00",
    paidPriceSensitive: "650.00",
    paidAgentPriceNormal: "500.00",
    paidAgentPriceInspection: "550.00",
    paidAgentPriceSensitive: "600.00",
    rebateAmount: "20.00",
    planCustomer: { clientId: "zz_c_a1", plan: { planNo: "WHR0000001" } },
    items: [
      { productName: "拖鞋", cargoType: "normal", volumeM3: "1.000000" },
    ],
    statusLogs: [
      { toStatus: "paid", createdAt: T("2026-08-04T03:00:00Z") },
      { toStatus: "loading", createdAt: T("2026-08-06T05:00:00Z") },
      { toStatus: "loading", createdAt: T("2026-08-05T05:00:00Z") },
      { toStatus: "shipped", createdAt: T("2026-08-08T06:00:00Z") },
    ],
    ...over,
  };
}

/* ────────────────────────── 开测 ────────────────────────── */

async function main(): Promise<void> {
  const rules = await import("../apps/api/src/modules/agents/agent-rules");
  const gen = await import("../apps/api/src/modules/agents/rebate-scheduler");
  const { hashPassword } = await import("../apps/api/src/modules/auth/crypto-utils");
  const { signAuthToken } = await import("../apps/api/src/modules/auth/token");
  const { createApp } = await import("../apps/api/src/server");
  const { registerAgentAdminRoutes } = await import("../apps/api/src/modules/agents/admin-routes");

  console.log("代理返现单");

  await check("1) 月份按北京时间切：UTC 9-30 16:00 是北京 10-01 0 点算 10 月，差 1 毫秒算 9 月", () => {
    assert.equal(rules.beijingMonthOf(T("2026-09-30T16:00:00.000Z")), "2026-10");
    assert.equal(rules.beijingMonthOf(T("2026-09-30T15:59:59.999Z")), "2026-09");
    assert.equal(rules.beijingMonthStart("2026-10").toISOString(), "2026-09-30T16:00:00.000Z");
    assert.equal(rules.beijingMonthEnd("2026-12").toISOString(), "2026-12-31T16:00:00.000Z", "跨年");
    assert.equal(rules.addMonths("2026-12", 1), "2027-01");
    assert.equal(rules.addMonths("2027-01", -1), "2026-12");
    assert.equal(rules.lastCompletedMonth(T("2026-09-30T16:00:00Z")), "2026-09", "北京 10 月 1 日 0 点起，9 月算过完");
    assert.equal(rules.lastCompletedMonth(T("2026-09-30T15:59:59Z")), "2026-08", "北京 9 月 30 日 23:59:59，9 月还没过完");
    assert.equal(rules.isValidMonth("2026-9"), false);
    assert.equal(rules.isValidMonth("2026-13"), false);
  });

  await check("2) 排单纯函数：当月不出、空月不出空单、已出的月跳过、迟到的进下一张没出的单", () => {
    const c = (id: string, t: string) => ({ id, thailandReceivedAt: T(t) });
    const now = T("2026-10-15T00:00:00Z"); // 北京 10 月，已过完到 9 月
    // 6 月一票、8 月两票、10 月一票（当月）
    let plan = rules.planAgentStatements(
      [c("jun", "2026-06-10T00:00:00Z"), c("aug2", "2026-08-31T15:59:59Z"), c("aug1", "2026-08-01T00:00:00Z"), c("oct", "2026-10-02T00:00:00Z")],
      new Set(), now,
    );
    assert.deepEqual(plan.map((p) => [p.month, p.items.map((i) => i.id)]), [["2026-06", ["jun"]], ["2026-08", ["aug1", "aug2"]]]);
    // 8 月已经出过：8 月那票迟到（签收时间落在 8 月，出单后才提交）→ 进 9 月
    plan = rules.planAgentStatements([c("late-aug", "2026-08-31T15:00:00Z")], new Set(["2026-08"]), now);
    assert.deepEqual(plan.map((p) => [p.month, p.items.map((i) => i.id)]), [["2026-09", ["late-aug"]]]);
    // 9 月也出过了：等到下个月再进
    plan = rules.planAgentStatements([c("late-aug", "2026-08-31T15:00:00Z")], new Set(["2026-08", "2026-09"]), now);
    assert.deepEqual(plan, []);
    assert.deepEqual(rules.planAgentStatements([], new Set(), now), []);
  });

  await check("3) 一票明细：6 个时间、品名去重、三档方数、快照价、返现用快照", () => {
    const line = gen.buildRebateLine(prealert("p1", {
      items: [
        { productName: "拖鞋", cargoType: "normal", volumeM3: "1.2345" },
        { productName: "拖鞋", cargoType: "inspection", volumeM3: "0.5" },
        { productName: " 充电宝 ", cargoType: "sensitive", volumeM3: null },
      ],
      rebateAmount: "33.45",
    }) as any)!;
    assert.equal(line.productNames, "拖鞋、充电宝");
    assert.deepEqual([line.volumeNormalM3, line.volumeInspectionM3, line.volumeSensitiveM3], [1.235, 0.5, 0]);
    assert.equal(line.rebateAmount, 33.45, "返现用付款快照，不按现在的价重算");
    assert.equal(line.prealertCreatedAt.toISOString(), "2026-08-01T01:00:00.000Z");
    assert.equal(line.signedAt!.toISOString(), "2026-08-03T02:00:00.000Z");
    assert.equal(line.paidAt!.toISOString(), "2026-08-04T03:00:00.000Z");
    assert.equal(line.loadedAt!.toISOString(), "2026-08-05T05:00:00.000Z", "装柜取最早一条");
    assert.equal(line.shippedAt!.toISOString(), "2026-08-08T06:00:00.000Z");
    assert.equal(line.thailandReceivedAt.toISOString(), "2026-08-20T04:00:00.000Z");
    assert.equal(line.mark, "MARK-A1");
    assert.equal(line.planNo, "WHR0000001");
    assert.equal(line.clientId, "zz_c_a1");
    assert.equal(line.clientPriceInspection, "600.00");
    assert.equal(line.agentPriceSensitive, "600.00");
  });

  await check("4) 快照返现为空按快照价现算；负数记 0；快照价缺一档不进单；没有装柜日志时间为空", () => {
    // 1 方普货 (520-500) + 0.5 方商检 (600-550) = 20 + 25 = 45
    const computed = gen.buildRebateLine(prealert("p2", {
      rebateAmount: null,
      items: [{ productName: "a", cargoType: "normal", volumeM3: 1 }, { productName: "b", cargoType: "inspection", volumeM3: 0.5 }],
      statusLogs: [],
    }) as any)!;
    assert.equal(computed.rebateAmount, 45);
    assert.equal(computed.loadedAt, null);
    assert.equal(computed.shippedAt, null);
    assert.equal(gen.buildRebateLine(prealert("p3", { rebateAmount: "-5.00" }) as any)!.rebateAmount, 0);
    assert.equal(gen.buildRebateLine(prealert("p4", { paidAgentPriceInspection: null }) as any), null);
  });

  // ── 端到端：跑生成器 ──
  db.agents = [
    { id: "agent_jia", companyId: "c1", name: "代理甲" },
    { id: "agent_yi", companyId: "c1", name: "代理乙" },
  ];
  db.prealerts = [
    prealert("aug-1", { thailandReceivedAt: T("2026-08-01T00:00:00Z"), rebateAmount: "20.00" }),
    // UTC 8-31 16:30 = 北京 9-01 00:30 → 9 月
    prealert("sep-edge", { thailandReceivedAt: T("2026-08-31T16:30:00Z"), rebateAmount: "10.50", mark: "MARK-A2", planCustomer: { clientId: "zz_c_a2", plan: { planNo: "WHR0000002" } } }),
    // UTC 8-31 15:59 = 北京 8-31 23:59 → 8 月
    prealert("aug-edge", { thailandReceivedAt: T("2026-08-31T15:59:00Z"), rebateAmount: "0.01" }),
    // 不该进的：代理乙、湘泰客户（paidAgentId 空）、还在路上、快照不全、别家公司
    prealert("yi-aug", { paidAgentId: "agent_yi", thailandReceivedAt: T("2026-08-10T00:00:00Z"), rebateAmount: "7.00" }),
    prealert("xt-aug", { paidAgentId: null, rebateAmount: null }),
    prealert("shipped", { status: "shipped", thailandReceivedAt: null }),
    prealert("no-snap", { paidPriceNormal: null, thailandReceivedAt: T("2026-08-11T00:00:00Z") }),
    prealert("other-co", { companyId: "c9", thailandReceivedAt: T("2026-08-12T00:00:00Z") }),
  ];

  let firstRun: Awaited<ReturnType<typeof gen.generateAgentRebateStatements>> | null = null;
  await check("5) 北京 9-01 00:05 跑：出 8 月的单（含 8-31 23:59 那票），北京 9-01 00:30 那票不进；代理乙单独一张", async () => {
    events = [];
    firstRun = await gen.generateAgentRebateStatements(T("2026-08-31T16:05:00Z"));
    assert.equal(firstRun.statementsCreated, 2);
    const jia = db.statements.filter((s) => s.agentId === "agent_jia");
    assert.deepEqual(jia.map((s) => s.month), ["2026-08"]);
    const jiaLines = db.lines.filter((l) => l.statementId === jia[0].id).map((l) => l.prealertId).sort();
    assert.deepEqual(jiaLines, ["aug-1", "aug-edge"]);
    assert.equal(jia[0].lineCount, 2);
    assert.equal(jia[0].totalRebate, 20.01, "分为单位累加，不许浮点差一分");
    assert.equal(jia[0].totalVolumeM3, 2);
    assert.equal(jia[0].status, "unpaid");
    assert.equal(jia[0].companyId, "c1");
    const yi = db.statements.filter((s) => s.agentId === "agent_yi");
    assert.deepEqual(yi.map((s) => [s.month, s.totalRebate]), [["2026-08", 7]]);
    const allLineIds = db.lines.map((l) => l.prealertId);
    for (const bad of ["sep-edge", "xt-aug", "shipped", "no-snap", "other-co"]) assert.ok(!allLineIds.includes(bad), `${bad} 不许进单`);
    assert.ok(firstRun.skippedPrealerts.includes("no-snap"), "快照不全的要报出来");
  });

  await check("6) 锁序：每个代理事务第一步锁 agents 行；只写返现单表，不写预报单", () => {
    const withWrites = txEvents.filter((ev) => ev.some((e) => e.startsWith("write:")));
    assert.ok(withWrites.length >= 2);
    for (const ev of txEvents) {
      assert.match(ev[0] ?? "", /^lock:agents:/, `事务第一步不是锁代理行：${ev.join(" → ")}`);
      for (const e of ev.filter((x) => x.startsWith("write:"))) assert.match(e, /^write:agent_rebate_statements:/);
    }
  });

  await check("7) 同一时刻再跑、隔一小时再跑：一张都不多出，已出的单金额明细不变", async () => {
    const before = clone({ statements: db.statements, lines: db.lines });
    const again = await gen.generateAgentRebateStatements(T("2026-08-31T16:05:00Z"));
    assert.equal(again.statementsCreated, 0);
    const hourLater = await gen.generateAgentRebateStatements(T("2026-08-31T17:05:00Z"));
    assert.equal(hourLater.statementsCreated, 0);
    assert.deepEqual({ statements: db.statements, lines: db.lines }, before);
  });

  await check("8) 进程内重入：上一轮没跑完时再调直接跳过", async () => {
    const [a, b] = await Promise.all([gen.runAgentRebateOnce(T("2026-08-31T16:05:00Z")), gen.runAgentRebateOnce(T("2026-08-31T16:05:00Z"))]);
    assert.ok(a !== null);
    assert.equal(b, null);
  });

  await check("9) 出单后才补点签收：签收时间在 9 月的进 9 月；迟到的 8 月那票也进 9 月，8 月的单不动", async () => {
    const augBefore = clone(db.statements.find((s) => s.agentId === "agent_jia" && s.month === "2026-08")!);
    db.prealerts.push(
      prealert("sep-late-click", { thailandReceivedAt: T("2026-09-20T02:00:00Z"), rebateAmount: "3.00" }),
      // 签收时间落在 8 月（事务提交晚了），8 月单已经出了
      prealert("aug-straggler", { thailandReceivedAt: T("2026-08-31T15:59:59Z"), rebateAmount: "4.00" }),
    );
    // 9 月当月跑：9 月还没过完，一张都不出
    let r = await gen.generateAgentRebateStatements(T("2026-09-15T00:00:00Z"));
    assert.equal(r.statementsCreated, 0, "当月不出单");
    // 北京 10-01 00:10 跑：出 9 月
    r = await gen.generateAgentRebateStatements(T("2026-09-30T16:10:00Z"));
    assert.equal(r.statementsCreated, 1);
    const sep = db.statements.find((s) => s.agentId === "agent_jia" && s.month === "2026-09")!;
    assert.deepEqual(db.lines.filter((l) => l.statementId === sep.id).map((l) => l.prealertId).sort(), ["aug-straggler", "sep-edge", "sep-late-click"]);
    assert.equal(sep.totalRebate, 17.5);
    const straggler = db.lines.find((l) => l.prealertId === "aug-straggler")!;
    assert.equal(straggler.thailandReceivedAt.toISOString(), "2026-08-31T15:59:59.000Z", "明细里泰国签收时间照实写");
    assert.deepEqual(db.statements.find((s) => s.id === augBefore.id), augBefore, "8 月的单一个字不许动");
  });

  await check("10) 库里已有同月单（唯一约束兜底）：不报错、不重复", async () => {
    db.prealerts.push(prealert("yi-oct", { paidAgentId: "agent_yi", thailandReceivedAt: T("2026-10-05T00:00:00Z"), rebateAmount: "1.00" }));
    // 模拟：锁里读「已出月份」时漏看了（别的进程刚插入），create 撞 UNIQUE
    const orig = models.agentRebateStatement.findMany;
    models.agentRebateStatement.findMany = async (args: Row) => (args?.where?.agentId === "agent_yi" && !args.where.companyId ? [] : orig(args));
    db.statements.push({ id: "stmt_pre", companyId: "c1", agentId: "agent_yi", month: "2026-10", lineCount: 0, totalVolumeM3: 0, totalRebate: 0, status: "unpaid", generatedAt: T("2026-11-01T00:00:00Z"), paidAt: null, paidBy: null });
    try {
      const r = await gen.generateAgentRebateStatements(T("2026-11-01T00:00:00Z"));
      assert.equal(db.statements.filter((s) => s.agentId === "agent_yi" && s.month === "2026-10").length, 1);
      assert.ok(!db.lines.some((l) => l.prealertId === "yi-oct"), "撞了唯一约束的那一轮整体回滚");
      assert.ok(r.agents === 2);
    } finally {
      models.agentRebateStatement.findMany = orig;
      db.statements = db.statements.filter((s) => s.id !== "stmt_pre");
    }
  });

  // ── 「已返」接口 ──
  db.users = [
    { id: "zz_admin", companyId: "c1", role: "admin", name: "老板", status: "active", passwordHash: hashPassword("Admin#2026x"), agentId: null },
    { id: "zz_admin_c2", companyId: "c2", role: "admin", name: "别家", status: "active", passwordHash: hashPassword("Admin#2026y"), agentId: null },
  ];
  const tokenFor = (id: string): string => {
    const u = db.users.find((x) => x.id === id)!;
    return signAuthToken({ userId: id, companyId: u.companyId, role: u.role, userName: u.name, passwordHash: u.passwordHash });
  };
  const app = createApp();
  registerAgentAdminRoutes(app);
  const port = await freePort();
  await new Promise<void>((resolve) => app.listen(port, resolve));
  const call = async (method: "GET" | "POST", p: string, token: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const admin = tokenFor("zz_admin");

  await check("11) 列表按代理 / 月份 / 状态筛；明细 4.20 字段写全", async () => {
    let r = await call("GET", "/admin/agents/rebates?agentId=agent_jia", admin);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.items.map((i: Row) => i.month).sort(), ["2026-08", "2026-09"]);
    assert.equal(r.body.data.items[0].agentName, "代理甲");
    r = await call("GET", "/admin/agents/rebates?month=2026-08", admin);
    assert.deepEqual(r.body.data.items.map((i: Row) => i.agentId).sort(), ["agent_jia", "agent_yi"]);
    r = await call("GET", "/admin/agents/rebates?month=2026-8", admin);
    assert.equal(r.status, 400);
    const aug = db.statements.find((s) => s.agentId === "agent_jia" && s.month === "2026-08")!;
    r = await call("GET", `/admin/agents/rebates/detail?id=${aug.id}`, admin);
    assert.equal(r.status, 200);
    const line = r.body.data.lines.find((l: Row) => l.prealertId === "aug-1");
    for (const key of ["mark", "productNames", "volumes", "clientPrices", "agentPrices", "rebateAmount", "prealertCreatedAt", "signedAt", "paidAt", "loadedAt", "shippedAt", "thailandReceivedAt", "trackingNo", "planNo"]) {
      assert.ok(line[key] !== undefined && line[key] !== null, `明细缺 ${key}`);
    }
    assert.deepEqual(line.clientPrices, { normal: 520, inspection: 600, sensitive: 650 });
    assert.deepEqual(line.agentPrices, { normal: 500, inspection: 550, sensitive: 600 });
    assert.ok(!("containerNo" in line), "不给柜号（3.11 暂缓）");
    const other = await call("GET", `/admin/agents/rebates/detail?id=${aug.id}`, tokenFor("zz_admin_c2"));
    assert.equal(other.status, 404, "别家公司看不到");
    const otherList = await call("GET", "/admin/agents/rebates", tokenFor("zz_admin_c2"));
    assert.deepEqual(otherList.body.data.items, []);
  });

  await check("12) 「已返」只改状态、时间、操作人；金额、方数、明细一个字不动；重复点不改时间；别家公司 404", async () => {
    const aug = db.statements.find((s) => s.agentId === "agent_jia" && s.month === "2026-08")!;
    const before = clone(aug);
    const linesBefore = clone(db.lines.filter((l) => l.statementId === aug.id));
    const other = await call("POST", "/admin/agents/rebates/mark-paid", tokenFor("zz_admin_c2"), { id: aug.id });
    assert.equal(other.status, 404);
    assert.equal(aug.status, "unpaid");

    const r = await call("POST", "/admin/agents/rebates/mark-paid", admin, { id: aug.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.alreadyPaid, false);
    const after = db.statements.find((s) => s.id === aug.id)!;
    const changed = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify((before as Row)[k])).sort();
    assert.deepEqual(changed, ["paidAt", "paidBy", "status"]);
    assert.equal(after.paidBy, "zz_admin");
    assert.deepEqual(db.lines.filter((l) => l.statementId === aug.id), linesBefore);

    const paidAt = after.paidAt;
    const again = await call("POST", "/admin/agents/rebates/mark-paid", admin, { id: aug.id });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.alreadyPaid, true);
    assert.equal(db.statements.find((s) => s.id === aug.id)!.paidAt, paidAt, "重复点不许改时间");

    // 已返之后再跑生成器也不动它
    await gen.generateAgentRebateStatements(T("2026-12-01T00:00:00Z"));
    assert.equal(db.statements.find((s) => s.id === aug.id)!.status, "paid");
  });

  await check("13) 返现合计超过 Decimal(12,2) 上限：不抛错、不写半截，这个代理从超限的月份起暂停出单，前面的月份照出，重跑也一样", async () => {
    db.agents.push({ id: "agent_bing", companyId: "c1", name: "代理丙" });
    db.prealerts.push(
      prealert("bing-jul", { paidAgentId: "agent_bing", thailandReceivedAt: T("2026-07-10T00:00:00Z"), rebateAmount: "10.00" }),
      // 单票各自放得下 Decimal(12,2)，同月加起来 1.2e10 放不下
      prealert("bing-aug-1", { paidAgentId: "agent_bing", thailandReceivedAt: T("2026-08-10T00:00:00Z"), rebateAmount: "6000000000.00" }),
      prealert("bing-aug-2", { paidAgentId: "agent_bing", thailandReceivedAt: T("2026-08-11T00:00:00Z"), rebateAmount: "6000000000.00" }),
      prealert("bing-aug-small", { paidAgentId: "agent_bing", thailandReceivedAt: T("2026-08-12T00:00:00Z"), rebateAmount: "5.00" }),
      prealert("bing-sep", { paidAgentId: "agent_bing", thailandReceivedAt: T("2026-09-10T00:00:00Z"), rebateAmount: "3.00" }),
    );
    for (let i = 0; i < 2; i += 1) {
      const r = await gen.generateAgentRebateStatements(T("2026-10-01T00:00:00Z"), { agentIds: ["agent_bing"] });
      assert.equal(r.statementsCreated, i === 0 ? 1 : 0, "只出 7 月那一张，重跑不多出");
      assert.deepEqual(r.overflowBlocked, [{ agentId: "agent_bing", month: "2026-08" }]);
      const bing = db.statements.filter((s) => s.agentId === "agent_bing");
      assert.deepEqual(bing.map((s) => s.month), ["2026-07"], "8 月超限不出，9 月也不越过去出");
      assert.equal(bing[0].totalRebate, 10);
      assert.ok(!db.lines.some((l) => String(l.prealertId).startsWith("bing-aug") || l.prealertId === "bing-sep"), "超限月份及以后的票一条明细都不写");
    }
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
