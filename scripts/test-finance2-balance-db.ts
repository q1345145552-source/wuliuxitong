/**
 * 财务系统2 客户余额（2026-11-27，ADR 0191，约定第 12 节）：真 PostgreSQL + 真 HTTP 服务 + 真迁移文件。
 *
 * 每次临时建一个空库（db push 刷结构 → 拆掉这次加的东西、放一条「上线前」的老流水 → 迁移文件连跑两遍），跑完整库删掉，
 * 不碰 DATABASE_URL 指的那个库里的任何数据。所以只许本机 / CI 的一次性库（地址是 localhost）+ AGENT_PORTAL_TEST_ALLOW_DB=1。
 *
 * 盯：
 *   迁移   两遍不报错、跟 schema 零差异、上线体检不报、老流水 tx_id = 0、新流水是真事务号、CHECK 在
 *   开关 / 钥匙   关着四个接口 503；钥匙不对 / 没带 401；新旧两把都认；跟只读接口同一把按关着；不跑登录解析
 *   扣款   扣满；不够扣一部分；余额 0 / 负数扣 0 不写流水、编号照记；钱包行不存在扣 0 不建行；
 *          同号同内容只扣一次回第一次的数；**两个一模一样的请求真并发只扣一次**；同号不同内容 409；
 *          不认识 / 不是客户角色 / 别的公司 404 且什么都不记；格式不对 400
 *   扣款 vs 集货付款真并发   余额对、流水对、不出现负数
 *   退回   正常；分两次；超了 409；同号重复只退一次；**两个不同编号同时退同一笔、加起来超了只成一个**；
 *          不认识的扣款 404；扣 0 的那次退不了；钱包行不在时退（两个同时）不撞主键
 *   查余额 / 流水   不认识的不出现、从没有过余额给 0；流水翻页不重不漏、到头了 nextCursor 照给、**后写先提交的那笔不被跳过**
 *   推送   动了钱推给那一个客户的 wallet；重复请求不推；别的客户收不到
 *   老路   集货付款 / 撤销付款的退款算法不被新流水搅（computePendingRefunds 只认自己的关联类型）
 *
 * 用法：npm run test:finance2-balance-db
 */
process.env.TZ = "UTC";
process.env.AUTH_SECRET ||= "test-only-fake-secret-not-a-real-key-do-not-use-in-production";
process.env.AGENT_REBATE_SCHEDULER = "off";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";

type Row = Record<string, any>;

const CO = "zz_f2b_co";
const OTHER_CO = "zz_f2b_other";
const KEY = "Bal4nce-k3y-aB3dE5gH7jK9mN1pQ3sT5vXyZ0123";
const OLD_KEY = "0ld-Bal4nce-k3y-zY8xW6vU4tS2rQ0pO9nM8765";
const READ_KEY = "R3ad-only-k3y-not-for-money-0123456789abc";
const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "apps/api/prisma/schema.prisma");
const MIGRATION = path.join(ROOT, "apps/api/prisma/migrations/20261127_finance2_balance/migration.sql");
const DRIFT = path.join(ROOT, "scripts/check-schema-drift.sql");

let failures = 0;
let passes = 0;
async function test(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passes++; console.log(`  ✅ ${label}`); }
  catch (e) { failures++; console.log(`  ❌ ${label}\n     ${(e instanceof Error ? e.stack ?? e.message : String(e)).split("\n").slice(0, 12).join("\n     ")}`); }
}

/** 测试期间所有日志接下来，最后查有没有密钥、有没有「认证失败」 */
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function runPrisma(args: string[], dbUrl: string): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["prisma", ...args], { cwd: ROOT, env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e: any) {
    return { code: typeof e.status === "number" ? e.status : 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：怕连到生产库不跑（确认是测试库再设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  const base = new URL(url);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(base.hostname)) {
    console.log("⚠️ 跳过：这一项要临时建库，只在本机 / CI 的一次性库上跑 —— 这一项等于没测");
    return;
  }

  /* ---------- 临时库：db push → 拆掉这次加的、放上线前的老流水 → 迁移连跑两遍 ---------- */
  const tmpName = `zz_f2bal_${Date.now().toString(36)}`;
  const tmp = new URL(url);
  tmp.pathname = `/${tmpName}`;
  const tmpUrl = tmp.toString();
  const admin = new PrismaClient({ datasources: { db: { url } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${tmpName}"`);
  const raw = new PrismaClient({ datasources: { db: { url: tmpUrl } } });
  try {
    const push = runPrisma(["db", "push", `--schema=${SCHEMA}`, "--skip-generate"], tmpUrl);
    assert.equal(push.code, 0, `临时库建结构失败：${push.out.slice(-400)}`);
    // 模拟「上线前的库」：没有新表、流水表没有 tx_id
    await raw.$executeRawUnsafe(`DROP TABLE "finance2_balance_requests"`);
    await raw.$executeRawUnsafe(`ALTER TABLE "consolidation_balance_ledger" DROP COLUMN "tx_id"`);
    await raw.$executeRawUnsafe(`INSERT INTO users (id, company_id, role, name, phone, status, password_hash) VALUES ('ZZF2BOLD', '${CO}', 'client', '老客户', '000', 'active', 'x')`);
    await raw.$executeRawUnsafe(`INSERT INTO client_wallet_accounts ("clientId", company_id, currency, balance, updated_at) VALUES ('ZZF2BOLD', '${CO}', 'CNY', 12.50, '2026-08-01T00:00:00')`);
    await raw.$executeRawUnsafe(`INSERT INTO consolidation_balance_ledger (id, company_id, client_id, type, amount, balance_after, ref_type, ref_id, ref_no, operator_id, operator_name, created_at)
      VALUES ('zzold1', '${CO}', 'ZZF2BOLD', 'recharge', 12.50, 12.50, 'recharge', 'rcg_old', NULL, 'zz_f2b_admin', '老板', '2026-08-01T00:00:00')`);
    for (const n of [1, 2]) {
      const r = runPrisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION], tmpUrl);
      assert.equal(r.code, 0, `迁移第 ${n} 遍失败：${r.out.slice(-400)}`);
    }

    process.env.DATABASE_URL = tmpUrl;
    process.env.NODE_ENV = "test";
    process.env.IMAGES_DIR = mkdtempSync(path.join(os.tmpdir(), "zz-f2b-img-"));
    process.env.FINANCE2_COMPANY_ID = CO;
    process.env.FINANCE2_BALANCE_ENABLED = "true";
    process.env.FINANCE2_BALANCE_KEY_SHA256 = sha256(KEY);
    process.env.FINANCE2_BALANCE_KEY_SHA256_PREV = sha256(OLD_KEY);
    process.env.FINANCE2_API_KEY_SHA256 = sha256(READ_KEY);

    const { prisma } = await import("../apps/api/src/db/prisma");
    const { createApp } = await import("../apps/api/src/server");
    const { registerFinance2BalanceRoutes } = await import("../apps/api/src/modules/finance2-balance/routes");
    const { registerConsolidationRoutes } = await import("../apps/api/src/modules/consolidation/routes");
    const { registerClientComplianceRoutes } = await import("../apps/api/src/modules/client-compliance/routes");
    const { LEDGER_ITEM_KEYS } = await import("../apps/api/src/modules/finance2-balance/views");
    const { realtimeHub } = await import("../apps/api/src/modules/realtime/hub");
    const wallet = await import("../apps/api/src/modules/wallet/consolidation-balance");
    const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
    const db = prisma as any;

    /* 集货付款等业务接口：真 handler，假 app（同 test-finance2-db 的写法） */
    const routes = new Map<string, Function>();
    const fake: any = {};
    for (const m of ["get", "post", "delete"]) fake[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
    registerConsolidationRoutes(fake);
    registerClientComplianceRoutes(fake);
    async function call(key: string, auth: Row, body: Row = {}, query: Row = {}): Promise<{ status: number; out: any }> {
      const handler = routes.get(key);
      assert.ok(handler, `没有这个接口：${key}`);
      let status = 200; let out: any;
      const res: any = { status(s: number) { status = s; return res; }, json(p: any) { out = p; }, setHeader() {} };
      try { await handler!({ method: key.split(" ")[0], body, query, headers: {}, auth, path: key.split(" ")[1] }, res); }
      catch (e) { if (e instanceof BusinessError) { status = e.httpStatus; out = { message: e.message }; } else throw e; }
      return { status, out };
    }

    /* 客户余额接口：真 HTTP 服务（连 server.ts 的路由和登录解析一起测） */
    const PORT = await freePort();
    const app = createApp();
    registerFinance2BalanceRoutes(app);
    await new Promise<void>((resolve) => app.listen(PORT, resolve));
    const BASE = `http://127.0.0.1:${PORT}/integrations/finance2-balance/v1`;
    async function api(method: "GET" | "POST", p: string, opts: { key?: string | null; body?: unknown; rawBody?: string } = {}): Promise<{ status: number; body: Row; text: string }> {
      const key = opts.key === undefined ? KEY : opts.key;
      const r = await fetch(`${BASE}${p}`, {
        method,
        headers: { ...(key === null ? {} : { authorization: `Bearer ${key}` }), "content-type": "application/json" },
        ...(method === "POST" ? { body: opts.rawBody ?? JSON.stringify(opts.body ?? {}) } : {}),
      });
      const text = await r.text();
      let body: Row = {};
      try { body = JSON.parse(text) as Row; } catch { /* 留空 */ }
      return { status: r.status, body, text };
    }
    const charge = (b: Row, key?: string | null) => api("POST", "/charges", { body: b, key });
    const refund = (b: Row, key?: string | null) => api("POST", "/refunds", { body: b, key });
    async function ok200(r: Promise<{ status: number; body: Row; text: string }>): Promise<Row> {
      const x = await r;
      assert.equal(x.status, 200, `应该 200，实际 ${x.status} ${x.text.slice(0, 300)}`);
      return x.body;
    }

    /* ---------- 基础数据 ---------- */
    const mkUser = (id: string, role: string, companyId = CO) =>
      db.user.create({ data: { id, companyId, role, name: `名字${id}`, phone: "000", status: "active", passwordHash: "x" } });
    const C_A = "ZZF2BA";        // 有钱
    const C_B = "ZZF2BB";        // 推送测试的旁观者
    const C_NOW = "ZZF2BNOW";    // 从没有过钱包行
    const C_NEG = "ZZF2BNEG";    // 余额是负数
    const C_PAY = "ZZF2BPAY";    // 跟集货付款抢
    const C_R = "ZZF2BR";        // 退回
    const C_X = "ZZF2BX";        // 零碎
    const C_OTHER = "ZZF2BOTH";  // 别的公司
    const STAFF = "zz_f2b_staff";
    for (const id of [C_A, C_B, C_NOW, C_NEG, C_PAY, C_R, C_X]) await mkUser(id, "client");
    await mkUser(C_OTHER, "client", OTHER_CO);
    await mkUser(STAFF, "staff");
    await mkUser("zz_f2b_admin", "admin");

    /** 直接把钱包设成这个数（测试布置用），同时按差额记一笔「充值到账」流水，让「余额 = 流水累加」对得上 */
    async function seed(clientId: string, amount: string, companyId = CO): Promise<void> {
      const now = await db.clientWalletAccount.findUnique({ where: { clientId_currency: { clientId, currency: "CNY" } }, select: { balance: true } });
      const delta = (Math.round(Number(amount) * 100) - Math.round(Number(now?.balance ?? 0) * 100)) / 100;
      await db.clientWalletAccount.upsert({
        where: { clientId_currency: { clientId, currency: "CNY" } },
        create: { clientId, companyId, currency: "CNY", balance: amount },
        update: { balance: amount },
      });
      if (delta !== 0) {
        await db.consolidationBalanceLedger.create({ data: { companyId, clientId, type: "recharge", amount: delta.toFixed(2), balanceAfter: amount, refType: "recharge", refId: `seed_${clientId}_${Date.now()}` } });
      }
    }
    const balanceOf = async (clientId: string): Promise<string | null> => {
      const a = await db.clientWalletAccount.findUnique({ where: { clientId_currency: { clientId, currency: "CNY" } }, select: { balance: true } });
      return a ? Number(a.balance).toFixed(2) : null;
    };
    const ledgerOf = (clientId: string) => db.consolidationBalanceLedger.findMany({ where: { clientId }, orderBy: [{ txId: "asc" }, { createdAt: "asc" }, { id: "asc" }] });
    /** 「余额 = 这个客户全部流水加起来」：流水对得上账 */
    async function assertLedgerMatchesBalance(clientId: string): Promise<void> {
      const rows: Row[] = await ledgerOf(clientId);
      const sum = rows.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0);
      assert.equal((sum / 100).toFixed(2), await balanceOf(clientId), `${clientId} 流水加起来跟余额对不上`);
    }

    /**
     * 另一个连接先把这个客户的钱包行锁住 ms 毫秒，再放开。让同时发出的几个请求都「查过编号 / 读过东西」以后才轮到动钱 ——
     * 不这么做，第一个请求常常在别的请求进门前就提交完了，并发测试测不出东西（变异实测过：去掉防护照样绿）。
     */
    async function withWalletHeld<T>(clientId: string, ms: number, fire: () => Promise<T>): Promise<T> {
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => { locked = r; });
      const blocker = raw.$transaction(async (t) => {
        await t.$queryRawUnsafe(`SELECT 1 FROM client_wallet_accounts WHERE "clientId" = '${clientId}' FOR UPDATE`);
        locked();
        await sleep(ms);
      }, { timeout: 15_000 });
      await isLocked;
      const out = fire();
      await blocker;
      return out;
    }

    const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    const CHARGE_KEYS = ["balanceAfter", "charged", "customerMark", "duplicate", "ledgerId", "requestId", "serverTime"];
    const REFUND_KEYS = ["balanceAfter", "chargeRequestId", "duplicate", "ledgerId", "refunded", "requestId", "serverTime"];

    /* ==================== 迁移 ==================== */
    console.log("\n【迁移文件】");
    await test("M1 上线前的库上连跑两遍不报错；跟 schema.prisma 零差异；上线体检一行不报；老流水 tx_id = 0；CHECK 和外键在", async () => {
      const diff = runPrisma(["migrate", "diff", "--from-url", tmpUrl, "--to-schema-datamodel", SCHEMA, "--script", "--exit-code"], tmpUrl);
      assert.equal(diff.code, 0, `还差这些：\n${diff.out.split("\n").filter((l) => l.trim() && !l.startsWith("--")).slice(0, 12).join("\n")}`);
      const drift = await raw.$queryRawUnsafe<Row[]>(readFileSync(DRIFT, "utf8"));
      assert.equal(drift.length, 0, `上线体检报了：${JSON.stringify(drift).slice(0, 300)}`);
      const old = await raw.$queryRawUnsafe<Row[]>(`SELECT tx_id::text AS x, amount::text AS a FROM consolidation_balance_ledger WHERE id = 'zzold1'`);
      assert.deepEqual(old, [{ x: "0", a: "12.50" }], "老流水 tx_id 是 0、内容不变");
      const cons = await raw.$queryRawUnsafe<Row[]>(`SELECT conname FROM pg_constraint WHERE conrelid = 'finance2_balance_requests'::regclass ORDER BY conname`);
      assert.deepEqual(cons.map((c) => c.conname), ["finance2_balance_requests_amount_shape", "finance2_balance_requests_client_id_fkey", "finance2_balance_requests_kind_shape", "finance2_balance_requests_pkey"]);
      const third = runPrisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION], tmpUrl);
      assert.equal(third.code, 0, "第三遍也不报错");
    });
    await test("M2 新写的流水 tx_id 是写它的那个事务号（同一事务两笔一样、不同事务递增）；CHECK 拦得住坏行", async () => {
      const ids = await raw.$transaction(async (t) => {
        await t.$executeRawUnsafe(`INSERT INTO consolidation_balance_ledger (id, company_id, client_id, type, amount, balance_after) VALUES ('zzm2a', '${OTHER_CO}', 'ZZF2BOLD', 'pay', -1, 0), ('zzm2b', '${OTHER_CO}', 'ZZF2BOLD', 'pay', -1, 0)`);
        return t.$queryRawUnsafe<Row[]>(`SELECT pg_current_xact_id()::text AS x`);
      });
      await raw.$executeRawUnsafe(`INSERT INTO consolidation_balance_ledger (id, company_id, client_id, type, amount, balance_after) VALUES ('zzm2c', '${OTHER_CO}', 'ZZF2BOLD', 'pay', -1, 0)`);
      const rows = await raw.$queryRawUnsafe<Row[]>(`SELECT id, tx_id::text AS x FROM consolidation_balance_ledger WHERE id LIKE 'zzm2%' ORDER BY id`);
      assert.equal(rows[0].x, ids[0].x);
      assert.equal(rows[1].x, ids[0].x);
      assert.ok(BigInt(rows[2].x) > BigInt(rows[0].x));
      await raw.$executeRawUnsafe(`DELETE FROM consolidation_balance_ledger WHERE id LIKE 'zzm2%'`);
      // 扣款不许有退回原因；实扣不许超过上限；没动钱不许挂流水
      for (const bad of [
        `('zzbad1','charge','f','${CO}','${C_X}','B1','bulk',10,NULL,'billVoided',0,0,NULL)`,
        `('zzbad2','charge','f','${CO}','${C_X}','B1','bulk',10,NULL,NULL,11,0,'L')`,
        `('zzbad3','charge','f','${CO}','${C_X}','B1','bulk',10,NULL,NULL,0,0,'L')`,
        `('zzbad4','refund','f','${CO}','${C_X}','B1',NULL,10,NULL,'billVoided',10,0,'L')`,
        `('zzbad5','charge','f','${CO}','${C_X}','B1','other',10,NULL,NULL,0,0,NULL)`,
      ]) {
        await assert.rejects(raw.$executeRawUnsafe(`INSERT INTO finance2_balance_requests (request_id, kind, fingerprint, company_id, client_id, bill_no, bill_kind, amount, charge_request_id, reason, result_amount, balance_after, ledger_id) VALUES ${bad}`), /check constraint|violates/i, bad);
      }
    });

    /* ==================== 开关 / 钥匙 ==================== */
    console.log("\n【开关 / 钥匙】");
    const anyCharge = { requestId: "zz-sw-1", customerMark: C_X, billNo: "B-SW", billKind: "bulk", maxAmount: "1.00" };
    await test("K1 开关不是 true：四个接口一律 503 disabled（带对的钥匙也一样），带 serverTime；什么都没写", async () => {
      for (const v of [undefined, "", "1", "TRUE", "yes"]) {
        if (v === undefined) delete process.env.FINANCE2_BALANCE_ENABLED; else process.env.FINANCE2_BALANCE_ENABLED = v;
        for (const r of await Promise.all([api("GET", "/balances?marks=x"), charge(anyCharge), refund({ requestId: "zz-sw-2", chargeRequestId: "zz-sw-1", amount: "1.00", reason: "billVoided" }), api("GET", "/ledger")])) {
          assert.equal(r.status, 503, `开关=${v} ${r.text}`);
          assert.equal(r.body.error, "disabled");
          assert.match(r.body.serverTime, ISO_Z);
        }
      }
      process.env.FINANCE2_BALANCE_ENABLED = "true";
      assert.equal(await db.finance2BalanceRequest.count(), 0);
    });
    await test("K2 开着但没配齐 / 跟只读接口同一把钥匙：按关着 503", async () => {
      const keep = { ...process.env };
      try {
        delete process.env.FINANCE2_COMPANY_ID;
        assert.equal((await api("GET", "/ledger")).status, 503);
        process.env.FINANCE2_COMPANY_ID = CO;
        delete process.env.FINANCE2_BALANCE_KEY_SHA256;
        assert.equal((await api("GET", "/ledger")).status, 503);
        process.env.FINANCE2_BALANCE_KEY_SHA256 = sha256(KEY);
        process.env.FINANCE2_API_KEY_SHA256 = sha256(KEY);
        assert.equal((await api("GET", "/ledger")).status, 503, "跟只读接口同一把：关着");
      } finally {
        Object.assign(process.env, keep);
        process.env.FINANCE2_API_KEY_SHA256 = sha256(READ_KEY);
      }
      assert.equal((await api("GET", "/ledger")).status, 200);
    });
    await test("K3 钥匙不对 / 没带 / 拿只读接口那把 / 登录令牌那种 → 401 unauthorized；新旧两把都 200；什么都没写", async () => {
      for (const key of ["wrong-key", null, READ_KEY, "eyJhbGciOiJIUzI1NiJ9.e30.x"]) {
        for (const r of await Promise.all([api("GET", "/balances?marks=x", { key }), charge(anyCharge, key), api("GET", "/ledger", { key })])) {
          assert.equal(r.status, 401, `${key} ${r.text}`);
          assert.equal(r.body.error, "unauthorized");
        }
      }
      assert.equal(await db.finance2BalanceRequest.count(), 0);
      assert.equal((await api("GET", "/ledger", { key: OLD_KEY })).status, 200);
      assert.equal((await api("GET", "/ledger", { key: KEY })).status, 200);
    });

    /* ==================== 扣款 ==================== */
    console.log("\n【扣款】");
    await seed(C_A, "1000.00");
    await test("C1 扣满：余额够 → 实扣 = 上限，余额减掉，写一笔 bill_charge 流水（负数、finance2_charge + 请求编号、账单号），字段一个不多一个不少", async () => {
      const b = await ok200(charge({ requestId: "zz-c1", customerMark: C_A, billNo: "B202612-001", billKind: "bulk", maxAmount: "300.00" }));
      assert.deepEqual(Object.keys(b).sort(), CHARGE_KEYS);
      assert.equal(b.requestId, "zz-c1");
      assert.equal(b.customerMark, C_A);
      assert.equal(b.charged, "300.00");
      assert.equal(b.balanceAfter, "700.00");
      assert.equal(b.duplicate, false);
      assert.match(b.serverTime, ISO_Z);
      assert.equal(await balanceOf(C_A), "700.00");
      const l = await db.consolidationBalanceLedger.findUnique({ where: { id: b.ledgerId } });
      assert.equal(l.type, "bill_charge");
      assert.equal(Number(l.amount), -300);
      assert.equal(Number(l.balanceAfter), 700);
      assert.equal(l.refType, "finance2_charge");
      assert.equal(l.refId, "zz-c1");
      assert.equal(l.refNo, "B202612-001");
      assert.equal(l.operatorId, null);
      assert.equal(l.operatorName, null);
      assert.equal(l.companyId, CO);
      const req = await db.finance2BalanceRequest.findUnique({ where: { requestId: "zz-c1" } });
      assert.equal(req.kind, "charge");
      assert.equal(req.billKind, "bulk");
      assert.equal(Number(req.amount), 300);
      assert.equal(Number(req.resultAmount), 300);
      assert.equal(req.ledgerId, b.ledgerId);
      await assertLedgerMatchesBalance(C_A);
    });
    await test("C2 余额不够：扣一部分（扣到 0 为止），不报错", async () => {
      const b = await ok200(charge({ requestId: "zz-c2", customerMark: C_A, billNo: "B202612-002", billKind: "fcl", maxAmount: "999.99" }));
      assert.equal(b.charged, "700.00");
      assert.equal(b.balanceAfter, "0.00");
      assert.ok(b.ledgerId);
      assert.equal(await balanceOf(C_A), "0.00");
      await assertLedgerMatchesBalance(C_A);
    });
    await test("C3 余额是 0：扣 0、ledgerId 是 null、不写流水，编号照记（再来还是 0.00，duplicate）", async () => {
      const before = (await ledgerOf(C_A)).length;
      const b = await ok200(charge({ requestId: "zz-c3", customerMark: C_A, billNo: "B3", billKind: "bulk", maxAmount: "50.00" }));
      assert.equal(b.charged, "0.00");
      assert.equal(b.balanceAfter, "0.00");
      assert.equal(b.ledgerId, null);
      assert.equal(b.duplicate, false);
      assert.equal((await ledgerOf(C_A)).length, before);
      assert.ok(await db.finance2BalanceRequest.findUnique({ where: { requestId: "zz-c3" } }));
      await seed(C_A, "80.00"); // 后来有钱了，同一个编号再来也不扣
      const again = await ok200(charge({ requestId: "zz-c3", customerMark: C_A, billNo: "B3", billKind: "bulk", maxAmount: "50.00" }));
      assert.deepEqual({ ...again, serverTime: "" }, { ...b, duplicate: true, serverTime: "" });
      assert.equal(await balanceOf(C_A), "80.00");
    });
    await test("C4 余额是负数：扣 0，余额照旧是负数（balanceAfter 给负数），不写流水", async () => {
      await seed(C_NEG, "-120.00");
      const b = await ok200(charge({ requestId: "zz-c4", customerMark: C_NEG, billNo: "B4", billKind: "bulk", maxAmount: "10.00" }));
      assert.equal(b.charged, "0.00");
      assert.equal(b.balanceAfter, "-120.00");
      assert.equal(b.ledgerId, null);
      assert.equal(await balanceOf(C_NEG), "-120.00");
    });
    await test("C5 从没有过钱包行的客户：扣 0、不建钱包行、不写流水，编号照记", async () => {
      const b = await ok200(charge({ requestId: "zz-c5", customerMark: C_NOW, billNo: "B5", billKind: "bulk", maxAmount: "10.00" }));
      assert.equal(b.charged, "0.00");
      assert.equal(b.balanceAfter, "0.00");
      assert.equal(b.ledgerId, null);
      assert.equal(await balanceOf(C_NOW), null, "不建钱包行");
      assert.equal((await ledgerOf(C_NOW)).length, 0);
    });
    await test("C6 同号同内容再来：不再扣，原样回第一次的数（balanceAfter 也是第一次那时候的）+ duplicate: true", async () => {
      await seed(C_X, "500.00");
      const first = await ok200(charge({ requestId: "zz-c6", customerMark: C_X, billNo: "B6", billKind: "bulk", maxAmount: "100.00" }));
      await ok200(charge({ requestId: "zz-c6-other", customerMark: C_X, billNo: "B6b", billKind: "bulk", maxAmount: "50.00" })); // 中间余额又变了
      const again = await ok200(charge({ requestId: "zz-c6", customerMark: C_X, billNo: "B6", billKind: "bulk", maxAmount: "100.00", extra: "多带的字段不算内容" }));
      assert.equal(again.duplicate, true);
      assert.equal(again.charged, "100.00");
      assert.equal(again.balanceAfter, "400.00", "第一次那时候的余额");
      assert.equal(again.ledgerId, first.ledgerId);
      assert.equal(await balanceOf(C_X), "350.00");
      assert.equal((await ledgerOf(C_X)).filter((l: Row) => l.refId === "zz-c6").length, 1);
    });
    await test("C7 同号不同内容（客户 / 账单号 / 种类 / 金额任何一样不同，或者拿退回的编号来扣）：409 request_conflict，不动钱", async () => {
      const before = await balanceOf(C_X);
      for (const b of [
        { requestId: "zz-c6", customerMark: C_X, billNo: "B6", billKind: "bulk", maxAmount: "100.01" },
        { requestId: "zz-c6", customerMark: C_X, billNo: "B6x", billKind: "bulk", maxAmount: "100.00" },
        { requestId: "zz-c6", customerMark: C_X, billNo: "B6", billKind: "fcl", maxAmount: "100.00" },
        { requestId: "zz-c6", customerMark: C_A, billNo: "B6", billKind: "bulk", maxAmount: "100.00" },
      ]) {
        const r = await charge(b);
        assert.equal(r.status, 409, r.text);
        assert.equal(r.body.error, "request_conflict");
        assert.match(r.body.serverTime, ISO_Z);
      }
      const asRefund = await refund({ requestId: "zz-c6", chargeRequestId: "zz-c6", amount: "1.00", reason: "billVoided" });
      assert.equal(asRefund.status, 409);
      assert.equal(asRefund.body.error, "request_conflict");
      assert.equal(await balanceOf(C_X), before);
    });
    await test("C8 不认识的客户 / 员工号 / 别的公司的客户 → 404 unknown_customer，编号不记（之后换对的客户照样能用这个编号）", async () => {
      await seed(C_OTHER, "100.00", OTHER_CO);
      for (const mark of ["ZZ_NOBODY", STAFF, "zz_f2b_admin", C_OTHER]) {
        const r = await charge({ requestId: "zz-c8", customerMark: mark, billNo: "B8", billKind: "bulk", maxAmount: "10.00" });
        assert.equal(r.status, 404, `${mark} ${r.text}`);
        assert.equal(r.body.error, "unknown_customer");
      }
      assert.equal(await db.finance2BalanceRequest.findUnique({ where: { requestId: "zz-c8" } }), null);
      assert.equal(await balanceOf(C_OTHER), "100.00", "别家公司的钱一分没动");
      const ok = await ok200(charge({ requestId: "zz-c8", customerMark: C_X, billNo: "B8", billKind: "bulk", maxAmount: "10.00" }));
      assert.equal(ok.duplicate, false);
    });
    await test("C9 格式不对 → 400 bad_request（带 message），什么都没写", async () => {
      const good = { requestId: "zz-c9", customerMark: C_X, billNo: "B9", billKind: "bulk", maxAmount: "10.00" };
      const bads: Row[] = [
        { ...good, maxAmount: 10 }, { ...good, maxAmount: "10" }, { ...good, maxAmount: "10.0" }, { ...good, maxAmount: "0.00" },
        { ...good, maxAmount: "-1.00" }, { ...good, maxAmount: "1,000.00" }, { ...good, maxAmount: " 10.00" }, { ...good, maxAmount: "1000000000000.00" },
        { ...good, requestId: "有中文" }, { ...good, requestId: "a".repeat(65) }, { ...good, requestId: "" }, { ...good, requestId: 12 },
        { ...good, billKind: "BULK" }, { ...good, billNo: "" }, { ...good, billNo: " B9" }, { ...good, customerMark: "" }, { ...good, customerMark: 1 },
        { requestId: "zz-c9" },
      ];
      for (const b of bads) {
        const r = await charge(b);
        assert.equal(r.status, 400, JSON.stringify(b));
        assert.equal(r.body.error, "bad_request");
        assert.ok(r.body.message);
      }
      for (const rawBody of ["", "not json", "[1]", "null"]) {
        const r = await api("POST", "/charges", { rawBody });
        assert.equal(r.status, 400, rawBody);
      }
      assert.equal(await db.finance2BalanceRequest.findUnique({ where: { requestId: "zz-c9" } }), null);
    });

    await test("C10 两个（8 个）一模一样的扣款真并发：只扣一次；8 个都 200，1 个 duplicate:false、7 个 duplicate:true，数字全一样", async () => {
      await seed(C_X, "1000.00");
      const body = { requestId: "zz-c10", customerMark: C_X, billNo: "B10", billKind: "bulk", maxAmount: "123.45" };
      const rs = await withWalletHeld(C_X, 500, () => Promise.all(Array.from({ length: 8 }, () => charge(body))));
      for (const r of rs) assert.equal(r.status, 200, r.text);
      assert.equal(rs.filter((r) => r.body.duplicate === false).length, 1);
      assert.equal(new Set(rs.map((r) => `${r.body.charged}|${r.body.balanceAfter}|${r.body.ledgerId}`)).size, 1);
      assert.equal(await balanceOf(C_X), "876.55");
      assert.equal((await ledgerOf(C_X)).filter((l: Row) => l.refId === "zz-c10").length, 1);
      await assertLedgerMatchesBalance(C_X);
    });
    await test("C11 不同编号的扣款 + 客户付集货拼柜真并发（钱包先被别人锁住、一起放开）：余额对、流水对、不出现负数", async () => {
      await seed(C_PAY, "1000.00");
      const tasks: string[] = [];
      for (let i = 0; i < 6; i++) {
        const t = await db.consolidationTask.create({ data: { taskNo: `JHZZ${String(i).padStart(5, "0")}`, companyId: CO, clientId: C_PAY, destinationTh: "-", status: "quoted", totalFee: "100.00" } });
        tasks.push(t.id);
      }
      const clientAuth = { userId: C_PAY, companyId: CO, role: "client", name: "", agentId: null };
      // 另一个连接先把这个钱包行锁住，让下面 12 个请求都排在它后面一起冲
      const results = await withWalletHeld(C_PAY, 500, () => Promise.all([
        ...tasks.map((taskId) => call("POST /client/consolidation/pay", clientAuth, { taskId })),
        ...Array.from({ length: 6 }, (_, i) => charge({ requestId: `zz-c11-${i}`, customerMark: C_PAY, billNo: `B11-${i}`, billKind: "bulk", maxAmount: "150.00" })),
      ]));
      const pays = results.slice(0, 6) as Array<{ status: number; out: any }>;
      const charges = results.slice(6) as Array<{ status: number; body: Row }>;
      for (const c of charges) assert.equal(c.status, 200);
      const paidTotal = pays.filter((p) => p.status === 200).length * 100;
      const chargedTotal = charges.reduce((s, c) => s + Math.round(Number(c.body.charged) * 100), 0) / 100;
      for (const p of pays) assert.ok(p.status === 200 || (p.status === 400 && /余额不足/.test(p.out?.message ?? "")), `集货付款：${p.status} ${p.out?.message}`);
      const final = Number(await balanceOf(C_PAY));
      assert.ok(final >= 0, `余额成了负数：${final}`);
      assert.equal((1000 - paidTotal - chargedTotal).toFixed(2), final.toFixed(2), `1000 - 付款 ${paidTotal} - 扣款 ${chargedTotal} ≠ 余额 ${final}`);
      await assertLedgerMatchesBalance(C_PAY);
      // 每笔流水的「这一笔之后的余额」按提交先后串起来对得上（没有两笔读到同一个旧余额）
      const rows: Row[] = (await ledgerOf(C_PAY)).filter((l: Row) => l.type !== "recharge" || l.refId?.startsWith("seed_"));
      const afters = rows.map((r) => Math.round(Number(r.balanceAfter) * 100));
      assert.equal(new Set(afters).size, afters.length, "有两笔流水记了同一个「之后的余额」= 有人读到了旧余额");
      // 扣款流水的金额 = 回给财务的实扣
      for (const c of charges) {
        if (c.body.ledgerId) assert.equal(Number((await db.consolidationBalanceLedger.findUnique({ where: { id: c.body.ledgerId } })).amount), -Number(c.body.charged));
      }
    });

    /* ==================== 退回 ==================== */
    console.log("\n【退回】");
    await seed(C_R, "500.00");
    const ch = await ok200(charge({ requestId: "zz-r-ch", customerMark: C_R, billNo: "B-R1", billKind: "fcl", maxAmount: "100.00" }));
    await test("R1 正常退：钱加回去，写一笔 bill_refund（正数，挂在原来那次扣款的编号上、账单号还是那张），字段一个不多一个不少", async () => {
      assert.equal(ch.charged, "100.00");
      const b = await ok200(refund({ requestId: "zz-r1", chargeRequestId: "zz-r-ch", amount: "60.00", reason: "overCharged" }));
      assert.deepEqual(Object.keys(b).sort(), REFUND_KEYS);
      assert.equal(b.requestId, "zz-r1");
      assert.equal(b.chargeRequestId, "zz-r-ch");
      assert.equal(b.refunded, "60.00");
      assert.equal(b.balanceAfter, "460.00");
      assert.equal(b.duplicate, false);
      const l = await db.consolidationBalanceLedger.findUnique({ where: { id: b.ledgerId } });
      assert.equal(l.type, "bill_refund");
      assert.equal(Number(l.amount), 60);
      assert.equal(l.refType, "finance2_charge");
      assert.equal(l.refId, "zz-r-ch");
      assert.equal(l.refNo, "B-R1");
      const req = await db.finance2BalanceRequest.findUnique({ where: { requestId: "zz-r1" } });
      assert.equal(req.kind, "refund");
      assert.equal(req.clientId, C_R);
      assert.equal(req.billNo, "B-R1");
      assert.equal(req.reason, "overCharged");
      await assertLedgerMatchesBalance(C_R);
    });
    await test("R2 分两次退：第二次把剩下的退完；再退 0.01 → 409 over_refund，不动钱、编号不记", async () => {
      const b = await ok200(refund({ requestId: "zz-r2", chargeRequestId: "zz-r-ch", amount: "40.00", reason: "billVoided" }));
      assert.equal(b.refunded, "40.00");
      assert.equal(b.balanceAfter, "500.00");
      const over = await refund({ requestId: "zz-r2b", chargeRequestId: "zz-r-ch", amount: "0.01", reason: "billVoided" });
      assert.equal(over.status, 409);
      assert.equal(over.body.error, "over_refund");
      assert.match(over.body.serverTime, ISO_Z);
      assert.equal(await balanceOf(C_R), "500.00");
      assert.equal(await db.finance2BalanceRequest.findUnique({ where: { requestId: "zz-r2b" } }), null);
    });
    await test("R3 同号重复退：只退一次，回第一次的数 + duplicate；同号不同内容 409 request_conflict", async () => {
      const again = await ok200(refund({ requestId: "zz-r2", chargeRequestId: "zz-r-ch", amount: "40.00", reason: "billVoided" }));
      assert.equal(again.duplicate, true);
      assert.equal(again.refunded, "40.00");
      assert.equal(again.balanceAfter, "500.00");
      for (const b of [
        { requestId: "zz-r2", chargeRequestId: "zz-r-ch", amount: "40.01", reason: "billVoided" },
        { requestId: "zz-r2", chargeRequestId: "zz-r-ch", amount: "40.00", reason: "receiptVoided" },
        { requestId: "zz-r2", chargeRequestId: "zz-c1", amount: "40.00", reason: "billVoided" },
      ]) {
        const r = await refund(b);
        assert.equal(r.status, 409, r.text);
        assert.equal(r.body.error, "request_conflict");
      }
      const charged = await charge({ requestId: "zz-r2", customerMark: C_R, billNo: "B-R1", billKind: "fcl", maxAmount: "40.00" });
      assert.equal(charged.status, 409, "拿退回的编号来扣：409");
      assert.equal(await balanceOf(C_R), "500.00");
      assert.equal((await ledgerOf(C_R)).filter((l: Row) => l.type === "bill_refund").length, 2);
    });
    await test("R4 不认识的扣款（没有 / 是退回的编号 / 别的公司的）→ 404 unknown_charge；扣了 0 的那次退 → 409 over_refund", async () => {
      await db.finance2BalanceRequest.create({ data: { requestId: "zz-r4-other", kind: "charge", fingerprint: "x", companyId: OTHER_CO, clientId: C_OTHER, billNo: "BO", billKind: "bulk", amount: "10.00", resultAmount: "0.00", balanceAfter: "100.00" } });
      for (const id of ["zz-nope", "zz-r1", "zz-r4-other"]) {
        const r = await refund({ requestId: `zz-r4-${id}`, chargeRequestId: id, amount: "1.00", reason: "billVoided" });
        assert.equal(r.status, 404, `${id} ${r.text}`);
        assert.equal(r.body.error, "unknown_charge");
      }
      const zero = await refund({ requestId: "zz-r4-zero", chargeRequestId: "zz-c5", amount: "1.00", reason: "billVoided" });
      assert.equal(zero.status, 409);
      assert.equal(zero.body.error, "over_refund");
      assert.equal(await balanceOf(C_NOW), null, "退不成也不建钱包行");
      for (const b of [{ requestId: "zz-r4b", chargeRequestId: "zz-r-ch", amount: "1", reason: "billVoided" }, { requestId: "zz-r4b", chargeRequestId: "zz-r-ch", amount: "1.00", reason: "other" }, { requestId: "zz-r4b", amount: "1.00", reason: "billVoided" }]) {
        const r = await refund(b);
        assert.equal(r.status, 400, JSON.stringify(b));
        assert.equal(r.body.error, "bad_request");
      }
    });
    await test("R5 两个不同编号同时退同一次扣款（70 + 70，扣的是 100）：只成一个，另一个 409 over_refund，余额对", async () => {
      const c = await ok200(charge({ requestId: "zz-r5-ch", customerMark: C_R, billNo: "B-R5", billKind: "bulk", maxAmount: "100.00" }));
      assert.equal(c.charged, "100.00");
      const rs = await withWalletHeld(C_R, 500, () => Promise.all([
        refund({ requestId: "zz-r5-a", chargeRequestId: "zz-r5-ch", amount: "70.00", reason: "billVoided" }),
        refund({ requestId: "zz-r5-b", chargeRequestId: "zz-r5-ch", amount: "70.00", reason: "billVoided" }),
      ]));
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], rs.map((r) => r.text).join(" | "));
      assert.equal(await balanceOf(C_R), "470.00");
      await assertLedgerMatchesBalance(C_R);
    });
    await test("R6 同一个退回编号 6 个一起来：只退一次", async () => {
      const c = await ok200(charge({ requestId: "zz-r6-ch", customerMark: C_R, billNo: "B-R6", billKind: "bulk", maxAmount: "50.00" }));
      const body = { requestId: "zz-r6", chargeRequestId: "zz-r6-ch", amount: c.charged, reason: "billVoided" };
      const rs = await withWalletHeld(C_R, 500, () => Promise.all(Array.from({ length: 6 }, () => refund(body))));
      for (const r of rs) assert.equal(r.status, 200, r.text);
      assert.equal(rs.filter((r) => r.body.duplicate === false).length, 1);
      assert.equal((await ledgerOf(C_R)).filter((l: Row) => l.type === "bill_refund" && l.refId === "zz-r6-ch").length, 1);
      await assertLedgerMatchesBalance(C_R);
    });
    await test("R7 钱包行不在的时候退（两个同时）：先建行再锁，不撞主键、不报错，钱一分不差", async () => {
      await seed(C_B, "100.00");
      await ok200(charge({ requestId: "zz-r7-ch", customerMark: C_B, billNo: "B-R7", billKind: "bulk", maxAmount: "100.00" }));
      // 模拟钱包行没了（正常不会发生：扣过钱的客户一定有行）
      await db.clientWalletAccount.delete({ where: { clientId_currency: { clientId: C_B, currency: "CNY" } } });
      const rs = await Promise.all([
        refund({ requestId: "zz-r7-a", chargeRequestId: "zz-r7-ch", amount: "30.00", reason: "billVoided" }),
        refund({ requestId: "zz-r7-b", chargeRequestId: "zz-r7-ch", amount: "30.00", reason: "billVoided" }),
      ]);
      for (const r of rs) assert.equal(r.status, 200, r.text);
      assert.equal(await balanceOf(C_B), "60.00");
      // 直接调公共函数再试一次「两个同时建行」
      await db.clientWalletAccount.delete({ where: { clientId_currency: { clientId: C_B, currency: "CNY" } } });
      const both = await Promise.allSettled([1, 2].map(() => prisma.$transaction((tx) => wallet.refundBillCharge(tx as any, { companyId: CO, clientId: C_B, amount: "10.00", chargeRequestId: "zz-r7-ch", billNo: "B-R7" }))));
      assert.deepEqual(both.map((b) => b.status), ["fulfilled", "fulfilled"], JSON.stringify(both.map((b) => (b as any).reason?.message)));
      assert.equal(await balanceOf(C_B), "20.00");
    });

    /* ==================== 查余额 ==================== */
    console.log("\n【查余额】");
    await test("B1 认识的给余额（负数也给、没钱包行的给 0.00 + updatedAt null）；员工号 / 别的公司 / 不认识的不出现；重复的只给一次；按传的顺序", async () => {
      const b = await ok200(api("GET", `/balances?marks=${[C_NEG, "ZZ_NOBODY", C_NOW, STAFF, C_OTHER, C_NEG, C_A].join(",")}`));
      assert.deepEqual(Object.keys(b).sort(), ["items", "serverTime"]);
      assert.deepEqual(b.items.map((i: Row) => i.customerMark), [C_NEG, C_NOW, C_A]);
      for (const i of b.items) assert.deepEqual(Object.keys(i).sort(), ["balance", "customerMark", "updatedAt"]);
      assert.equal(b.items[0].balance, "-120.00");
      assert.match(b.items[0].updatedAt, ISO_Z);
      assert.deepEqual(b.items[1], { customerMark: C_NOW, balance: "0.00", updatedAt: null });
      assert.equal(b.items[2].balance, await balanceOf(C_A));
    });
    await test("B2 marks 没带 / 空 / 有空的一段 / 超过 200 个 → 400；正好 200 个 200", async () => {
      for (const q of ["", "?marks=", `?marks=${C_A},,${C_NEG}`, `?marks=${Array.from({ length: 201 }, (_, i) => `M${i}`).join(",")}`]) {
        const r = await api("GET", `/balances${q}`);
        assert.equal(r.status, 400, q.slice(0, 40));
        assert.equal(r.body.error, "bad_request");
      }
      assert.equal((await api("GET", `/balances?marks=${Array.from({ length: 200 }, (_, i) => `M${i}`).join(",")}`)).status, 200);
    });

    /* ==================== 流水 ==================== */
    console.log("\n【流水】");
    async function pullAll(limit?: number, from?: string, between?: () => Promise<void>): Promise<{ items: Row[]; cursor: string }> {
      const items: Row[] = [];
      let cursor = from;
      for (let page = 0; page < 500; page++) {
        const q = new URLSearchParams();
        if (limit !== undefined) q.set("limit", String(limit));
        if (cursor) q.set("cursor", cursor);
        const b = await ok200(api("GET", `/ledger?${q.toString()}`));
        assert.deepEqual(Object.keys(b).sort(), ["hasMore", "items", "nextCursor", "serverTime"]);
        assert.equal(typeof b.nextCursor, "string", "nextCursor 一直给");
        items.push(...b.items);
        cursor = b.nextCursor;
        if (!b.hasMore) return { items, cursor: cursor! };
        if (between) await between();
      }
      throw new Error("翻了 500 页还没完");
    }
    await test("L1 一页页拉完：全公司每一笔都在、一笔不重、别家公司的不在；字段就那 11 个；金额两位小数字符串、时间带 Z；老流水在最前", async () => {
      const all = await pullAll(7);
      const ids = all.items.map((i) => i.id);
      assert.equal(new Set(ids).size, ids.length, "有重复");
      const expected = (await db.consolidationBalanceLedger.findMany({ where: { companyId: CO }, select: { id: true } })).map((r: Row) => r.id).sort();
      assert.deepEqual([...ids].sort(), expected);
      assert.equal(all.items[0].id, "zzold1");
      for (const it of all.items) {
        assert.deepEqual(Object.keys(it), [...LEDGER_ITEM_KEYS]);
        assert.match(it.amount, /^-?\d+\.\d{2}$/);
        assert.match(it.balanceAfter, /^-?\d+\.\d{2}$/);
        assert.match(it.createdAt, ISO_Z);
      }
      const old = all.items[0];
      assert.deepEqual(old, { id: "zzold1", customerMark: "ZZF2BOLD", type: "recharge", amount: "12.50", balanceAfter: "12.50", refType: "recharge", refId: "rcg_old", refNo: null, remark: null, operatorName: "老板", createdAt: "2026-08-01T00:00:00.000Z" });
      const billCharge = all.items.find((i) => i.refId === "zz-c1" && i.type === "bill_charge")!;
      assert.equal(billCharge.amount, "-300.00");
      assert.equal(billCharge.refType, "finance2_charge");
      assert.equal(billCharge.refNo, "B202612-001");
      assert.equal(billCharge.operatorName, null, "财务来扣的没有操作人");
      const pay = all.items.find((i) => i.type === "pay" && i.customerMark === C_PAY);
      assert.equal(pay?.operatorName, C_PAY, "客户自己付的：显示唛头");
      assert.ok(all.items.some((i) => i.type === "bill_refund"));
    });
    await test("L2 一页 200 默认、最多 500；limit 0 / 501 / 小数 / 负数 → 400；cursor 乱写 → 400", async () => {
      const b = await ok200(api("GET", "/ledger"));
      assert.ok(b.items.length <= 200);
      assert.equal((await api("GET", "/ledger?limit=500")).status, 200);
      for (const q of ["limit=0", "limit=501", "limit=1.5", "limit=-1", "limit=abc", "cursor=xyz", "cursor=", `cursor=${Buffer.from('{"x":"1","t":"2026-01-01T00:00:00Z","i":"a"}').toString("base64url")}`, `cursor=${Buffer.from('{"x":"a","t":"2026-01-01T00:00:00.000Z","i":"a"}').toString("base64url")}`]) {
        const r = await api("GET", `/ledger?${q}`);
        assert.equal(r.status, 400, q);
        assert.equal(r.body.error, "bad_request");
      }
    });
    await test("L3 到头了 hasMore:false、nextCursor 照给；拿它接着拉只给新写的那几笔", async () => {
      const first = await pullAll(50);
      const again = await ok200(api("GET", `/ledger?cursor=${first.cursor}`));
      assert.deepEqual(again.items, []);
      assert.equal(again.hasMore, false);
      assert.equal(again.nextCursor, first.cursor, "一条都没有：原样给回去");
      await ok200(charge({ requestId: "zz-l3", customerMark: C_X, billNo: "B-L3", billKind: "bulk", maxAmount: "1.00" }));
      const next = await pullAll(50, first.cursor);
      assert.deepEqual(next.items.map((i) => i.refId), ["zz-l3"]);
    });
    await test("L4 后写的先提交：先开始写的那个事务还没提交时，后提交的那笔先不给（游标不越过它）；先开始的提交后两笔都拉得到，一笔不漏", async () => {
      const start = (await pullAll(500)).cursor;
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let aWritten!: () => void;
      const aIn = new Promise<void>((r) => { aWritten = r; });
      // A：先写（拿到较小的事务号），不提交
      const a = raw.$transaction(async (t) => {
        await t.$executeRawUnsafe(`INSERT INTO consolidation_balance_ledger (id, company_id, client_id, type, amount, balance_after) VALUES ('zzl4a', '${CO}', '${C_X}', 'topup', 1, 1)`);
        aWritten();
        await gate;
      }, { timeout: 15_000 });
      await aIn;
      // B：后写、先提交
      await raw.$executeRawUnsafe(`INSERT INTO consolidation_balance_ledger (id, company_id, client_id, type, amount, balance_after) VALUES ('zzl4b', '${CO}', '${C_X}', 'topup', 1, 2)`);
      const mid = await pullAll(500, start);
      assert.deepEqual(mid.items.map((i) => i.id), [], "A 没提交：B 也先不给（给了游标就越过 A 了）");
      release();
      await a;
      const after = await pullAll(500, mid.cursor);
      assert.deepEqual(after.items.map((i) => i.id), ["zzl4a", "zzl4b"], "两笔都拉到，按事务先后");
      await raw.$executeRawUnsafe(`DELETE FROM consolidation_balance_ledger WHERE id IN ('zzl4a', 'zzl4b')`);
    });
    await test("L5 翻页途中又写了好几笔（每拉一页写一笔）：全部拉到、一笔不重", async () => {
      const start = (await pullAll(500)).cursor;
      for (let i = 0; i < 3; i++) await ok200(charge({ requestId: `zz-l5-pre${i}`, customerMark: C_X, billNo: "B-L5", billKind: "bulk", maxAmount: "1.00" }));
      let n = 0;
      const got = await pullAll(1, start, async () => {
        if (n < 5) await ok200(charge({ requestId: `zz-l5-${n++}`, customerMark: C_X, billNo: "B-L5", billKind: "bulk", maxAmount: "1.00" }));
      });
      assert.equal(n, 5, "翻页途中真的写了 5 笔");
      const tail = await pullAll(1, got.cursor);
      const ids = [...got.items, ...tail.items].map((i) => i.refId as string);
      assert.equal(new Set(ids).size, ids.length, "有重复");
      assert.deepEqual(ids.sort(), ["zz-l5-0", "zz-l5-1", "zz-l5-2", "zz-l5-3", "zz-l5-4", "zz-l5-pre0", "zz-l5-pre1", "zz-l5-pre2"]);
    });

    /* ==================== 推送 ==================== */
    console.log("\n【推送 / 客户页面】");
    await test("P1 扣 / 退真动了钱：推给那一个客户「wallet」；重复请求、扣 0 不推；别的客户收不到", async () => {
      const writes = new Map<string, string[][]>();
      const conns = [C_X, C_B].map((userId) => {
        const c = { id: realtimeHub.allocateId(), userId, companyId: CO, role: "client" as const, agentId: null, write(t: string[]) { writes.set(userId, [...(writes.get(userId) ?? []), t]); }, close() {} };
        realtimeHub.add(c);
        return c;
      });
      try {
        await ok200(charge({ requestId: "zz-p1", customerMark: C_X, billNo: "B-P1", billKind: "bulk", maxAmount: "2.00" }));
        await sleep(300);
        assert.deepEqual(writes.get(C_X), [["wallet"]]);
        assert.equal(writes.get(C_B), undefined, "别的客户收不到");
        await ok200(charge({ requestId: "zz-p1", customerMark: C_X, billNo: "B-P1", billKind: "bulk", maxAmount: "2.00" }));
        await ok200(charge({ requestId: "zz-p1-zero", customerMark: C_NOW, billNo: "B-P1", billKind: "bulk", maxAmount: "2.00" }));
        await sleep(300);
        assert.deepEqual(writes.get(C_X), [["wallet"]], "重复的不推");
        await ok200(refund({ requestId: "zz-p1-r", chargeRequestId: "zz-p1", amount: "2.00", reason: "billVoided" }));
        await sleep(300);
        assert.deepEqual(writes.get(C_X), [["wallet"], ["wallet"]]);
      } finally {
        for (const c of conns) realtimeHub.remove(c.id);
      }
    });
    await test("P2 客户余额页的流水：新类型显示中文（运费账单扣款 / 账单作废退回、来源「运费账单」、单号是账单号），不漏英文", async () => {
      const r = await call("GET /client/wallet/ledger", { userId: C_R, companyId: CO, role: "client", name: "", agentId: null }, {}, { pageSize: "50" });
      assert.equal(r.status, 200);
      const items = r.out.data.items as Row[];
      const charged = items.find((i) => i.type === "bill_charge")!;
      assert.equal(charged.typeLabel, "运费账单扣款");
      assert.equal(charged.source, "运费账单");
      assert.match(charged.refNo, /^B-R/);
      assert.equal(items.find((i) => i.type === "bill_refund")!.typeLabel, "账单作废退回");
      for (const i of items) assert.doesNotMatch(`${i.typeLabel}${i.source}`, /[a-z_]{4,}/, `英文漏到客户页面上了：${i.typeLabel} / ${i.source}`);
    });

    /* ==================== 老路 ==================== */
    console.log("\n【集货老路】");
    await test("O1 集货删单 / 撤销付款按 ref_type + ref_id 算退款：财务扣款的流水不算进去（关联类型不共用）", async () => {
      // 拿一个跟扣款编号同名的集货任务 id 试：关联类型不一样就不会算串
      const pending = await wallet.computePendingRefunds(prisma as any, [{ refType: "normal", refId: "zz-r-ch" }, { refType: "whr", refId: "zz-r-ch" }]);
      assert.deepEqual(pending, []);
      const own = await wallet.computePendingRefunds(prisma as any, [{ refType: "finance2_charge", refId: "zz-r5-ch" }]);
      assert.deepEqual(own.map((p) => [p.clientId, p.amount]), [[C_R, 30]], "按自己的关联类型算，扣 100 退 70 还剩 30");
    });

    console.log("\n【等锁有头（2026-11-27 审查第 4 条）】");
    /** 另一个连接拿着一把锁 holdMs 毫秒；返回「拿到锁了」和「放开了」两个信号 */
    function hold(sql: string, holdMs: number): { locked: Promise<void>; done: Promise<unknown> } {
      let locked!: () => void;
      const lockedP = new Promise<void>((r) => { locked = r; });
      const done = raw.$transaction(async (t) => {
        await t.$executeRawUnsafe(sql);
        locked();
        await sleep(holdMs);
      }, { timeout: holdMs + 10_000, maxWait: 5_000 });
      return { locked: lockedP, done };
    }
    /** 本库里除了我们自己这条，还有没有连接正在等锁（接口回了以后不该还有人在等） */
    const waitingBackends = async () => Number((await raw.$queryRawUnsafe<Row[]>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`))[0].n);
    await test("T1 钱包行被别人锁住 9.5 秒：扣款 8 秒内回 503 busy（钱没动、编号没记）、连接没被占着；放开后原样重发能办成、只扣一次", async () => {
      await seed(C_X, "300.00");
      const body = { requestId: "zz-t1", customerMark: C_X, billNo: "B-T1", billKind: "bulk", maxAmount: "10.00" };
      const h = hold(`SELECT 1 FROM client_wallet_accounts WHERE "clientId" = '${C_X}' FOR UPDATE`, 9_500);
      await h.locked;
      const t0 = Date.now();
      const r = await charge(body);
      const ms = Date.now() - t0;
      console.log(`     扣款等了 ${ms} 毫秒，回 ${r.status} ${r.body.error ?? ""}`);
      assert.equal(r.status, 503, r.text);
      assert.equal(r.body.error, "busy");
      assert.match(r.body.serverTime, ISO_Z);
      assert.ok(ms < 8_000, `${ms} 毫秒，超过 8 秒（财务只等 10 秒）`);
      assert.equal(await db.finance2BalanceRequest.findUnique({ where: { requestId: "zz-t1" } }), null, "编号没记");
      assert.equal(await balanceOf(C_X), "300.00", "钱没动");
      assert.equal(await waitingBackends(), 0, "回了 503 以后没有连接还在等锁");
      await h.done;
      const again = await ok200(charge(body));
      assert.equal(again.duplicate, false, "上一次整个回滚了，这次是第一次办成");
      assert.equal(again.charged, "10.00");
      const third = await ok200(charge(body));
      assert.equal(third.duplicate, true);
      assert.equal(await balanceOf(C_X), "290.00", "只扣一次");
      assert.equal((await ledgerOf(C_X)).filter((l: Row) => l.refId === "zz-t1").length, 1);
    });
    await test("T2 同一个请求编号的排队锁被别人一直拿着：也是 8 秒内 503 busy；退回同样有头", async () => {
      const h = hold(`SELECT pg_advisory_xact_lock(83092, hashtext('zz-t2'))`, 9_500);
      await h.locked;
      const t0 = Date.now();
      const r = await charge({ requestId: "zz-t2", customerMark: C_X, billNo: "B-T2", billKind: "bulk", maxAmount: "1.00" });
      const ms = Date.now() - t0;
      assert.equal(r.status, 503, r.text);
      assert.ok(ms < 8_000, `${ms} 毫秒`);
      await h.done;
      const h2 = hold(`SELECT 1 FROM client_wallet_accounts WHERE "clientId" = '${C_X}' FOR UPDATE`, 9_500);
      await h2.locked;
      const t1 = Date.now();
      const rf = await refund({ requestId: "zz-t2-r", chargeRequestId: "zz-t1", amount: "1.00", reason: "billVoided" });
      const ms2 = Date.now() - t1;
      console.log(`     排队锁那次等了 ${ms} 毫秒；退回等了 ${ms2} 毫秒，回 ${rf.status}`);
      assert.equal(rf.status, 503, rf.text);
      assert.ok(ms2 < 8_000, `${ms2} 毫秒`);
      await h2.done;
      assert.equal((await ok200(refund({ requestId: "zz-t2-r", chargeRequestId: "zz-t1", amount: "1.00", reason: "billVoided" }))).duplicate, false);
      assert.equal(await waitingBackends(), 0);
    });

    await test("Z1 日志里没有密钥、没有指纹；这几条路径没跑登录解析（没有「认证失败」）", async () => {
      const all = captured.join("\n");
      for (const s of [KEY, OLD_KEY, READ_KEY, sha256(KEY), sha256(OLD_KEY)]) assert.ok(!all.includes(s), "日志里出现了密钥或指纹");
      assert.ok(!/认证失败/.test(all), "跑了登录解析");
    });

    await prisma.$disconnect();
  } finally {
    await raw.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${tmpName}" WITH (FORCE)`);
    await admin.$disconnect();
  }

  console.log(`\n通过 ${passes}，失败 ${failures}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
