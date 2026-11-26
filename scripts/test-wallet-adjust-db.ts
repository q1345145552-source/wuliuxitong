/**
 * 客户余额第 2 轮：管理员加 / 减 / 冲掉、按客户看流水（2026-11-27，财务系统2 ADR 0191）—— 真 PostgreSQL + 真 handler + 真迁移文件。
 *
 * 临时建一个空库（db push 刷结构 → 拆掉调整单表 → 迁移连跑两遍），跑完整库删掉；只许本机 / CI 的一次性库 + AGENT_PORTAL_TEST_ALLOW_DB=1。
 *
 * 盯：
 *   迁移   两遍不报错、跟 schema 零差异、上线体检不报、CHECK 和外键在
 *   加金额  正常；带水单（格式不对 / 太大 / 不是图 → 400 不写）；**同一个提交编号连点（真并发）只加一笔**；同号不同内容 409
 *   减金额  正常；减成负数整笔拒绝（钱和编号都不动）；必须写原因；**两笔同时减、加起来超了只成一笔**
 *   冲掉   整笔冲、记谁 / 何时 / 为什么；同号重复回第一次；**两个管理员同时冲同一笔只冲一次**；冲成负数照冲；只有管理员充值能冲；客户对不上拒
 *   负数余额  客户付集货拼柜被拒（余额不足）；财务来扣扣 0
 *   加金额 vs 客户付集货拼柜真并发   余额对、流水对
 *   权限   员工 / 客户调加减冲 403；别家公司的客户 404；员工看流水看不到操作人；水单只给管理员
 *   流水   财务 /ledger 里三种流水的 refType / refId / remark / operatorName；客户页中文名、来源「后台调整」、不漏英文
 *   老路   客户提交充值 → 管理员通过照旧
 *
 * 用法：npm run test:wallet-adjust-db
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

const CO = "zz_wadj_co";
const OTHER_CO = "zz_wadj_other";
const KEY = "Wadj-bal4nce-k3y-aB3dE5gH7jK9mN1pQ3sT5vX";
const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "apps/api/prisma/schema.prisma");
const MIGRATION = path.join(ROOT, "apps/api/prisma/migrations/20261127_wallet_adjustments/migration.sql");
const DRIFT = path.join(ROOT, "scripts/check-schema-drift.sql");

let failures = 0;
let passes = 0;
async function test(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passes++; console.log(`  ✅ ${label}`); }
  catch (e) { failures++; console.log(`  ❌ ${label}\n     ${(e instanceof Error ? e.stack ?? e.message : String(e)).split("\n").slice(0, 12).join("\n     ")}`); }
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
let keySeq = 0;
/** 一次性提交编号（页面上是 32 位十六进制） */
const newKey = () => `zzkey${Date.now().toString(36)}${(++keySeq).toString().padStart(6, "0")}xx`;

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

  const tmpName = `zz_wadj_${Date.now().toString(36)}`;
  const tmp = new URL(url);
  tmp.pathname = `/${tmpName}`;
  const tmpUrl = tmp.toString();
  const admin = new PrismaClient({ datasources: { db: { url } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${tmpName}"`);
  const raw = new PrismaClient({ datasources: { db: { url: tmpUrl } } });
  try {
    const push = runPrisma(["db", "push", `--schema=${SCHEMA}`, "--skip-generate"], tmpUrl);
    assert.equal(push.code, 0, `临时库建结构失败：${push.out.slice(-400)}`);
    await raw.$executeRawUnsafe(`DROP TABLE "wallet_adjustments"`);
    for (const n of [1, 2]) {
      const r = runPrisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION], tmpUrl);
      assert.equal(r.code, 0, `迁移第 ${n} 遍失败：${r.out.slice(-400)}`);
    }

    process.env.DATABASE_URL = tmpUrl;
    process.env.NODE_ENV = "test";
    process.env.IMAGES_DIR = mkdtempSync(path.join(os.tmpdir(), "zz-wadj-img-"));
    process.env.FINANCE2_COMPANY_ID = CO;
    process.env.FINANCE2_BALANCE_ENABLED = "true";
    process.env.FINANCE2_BALANCE_KEY_SHA256 = sha256(KEY);

    const { prisma } = await import("../apps/api/src/db/prisma");
    const { createApp } = await import("../apps/api/src/server");
    const { registerFinance2BalanceRoutes } = await import("../apps/api/src/modules/finance2-balance/routes");
    const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
    const db = prisma as any;

    const routes = new Map<string, Function>();
    const fake: any = {};
    for (const m of ["get", "post", "delete"]) fake[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
    (await import("../apps/api/src/modules/wallet/admin-adjust-routes")).registerWalletAdjustRoutes(fake);
    (await import("../apps/api/src/modules/consolidation/routes")).registerConsolidationRoutes(fake);
    (await import("../apps/api/src/modules/client-compliance/routes")).registerClientComplianceRoutes(fake);
    (await import("../apps/api/src/modules/admin/routes")).registerAdminRoutes(fake);
    async function call(key: string, auth: Row, body: Row = {}, query: Row = {}): Promise<{ status: number; out: any }> {
      const handler = routes.get(key);
      assert.ok(handler, `没有这个接口：${key}`);
      let status = 200; let out: any;
      const res: any = { status(s: number) { status = s; return res; }, json(p: any) { out = p; }, setHeader() {} };
      try { await handler!({ method: key.split(" ")[0], body, query, headers: {}, auth, path: key.split(" ")[1] }, res); }
      catch (e) { if (e instanceof BusinessError) { status = e.httpStatus; out = { message: e.message }; } else throw e; }
      return { status, out };
    }
    const ok200 = async (p: Promise<{ status: number; out: any }>) => { const r = await p; assert.equal(r.status, 200, `应该 200，实际 ${r.status}：${r.out?.message}`); return r.out.data; };

    // 财务系统2 的扣款 / 流水：真 HTTP
    const PORT = await freePort();
    const app = createApp();
    registerFinance2BalanceRoutes(app);
    await new Promise<void>((resolve) => app.listen(PORT, resolve));
    const F2 = `http://127.0.0.1:${PORT}/integrations/finance2-balance/v1`;
    const f2 = async (method: "GET" | "POST", p: string, body?: Row) => {
      const r = await fetch(`${F2}${p}`, { method, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: r.status, body: await r.json() as Row };
    };

    /* ---------- 基础数据 ---------- */
    const mkUser = (id: string, role: string, companyId = CO, name = `名字${id}`) =>
      db.user.create({ data: { id, companyId, role, name, phone: "000", status: "active", passwordHash: "x" } });
    const ADMIN = { userId: "zz_wadj_admin", companyId: CO, role: "admin", name: "管理员甲", agentId: null };
    const ADMIN2 = { userId: "zz_wadj_admin2", companyId: CO, role: "admin", name: "管理员乙", agentId: null };
    const STAFF = { userId: "zz_wadj_staff", companyId: CO, role: "staff", name: "员工丙", agentId: null };
    const OTHER_ADMIN = { userId: "zz_wadj_oadmin", companyId: OTHER_CO, role: "admin", name: "别家管理员", agentId: null };
    await mkUser(ADMIN.userId, "admin", CO, ADMIN.name);
    await mkUser(ADMIN2.userId, "admin", CO, ADMIN2.name);
    await mkUser(STAFF.userId, "staff", CO, STAFF.name);
    await mkUser(OTHER_ADMIN.userId, "admin", OTHER_CO, OTHER_ADMIN.name);
    const C = { A: "ZZWADJA", B: "ZZWADJB", N: "ZZWADJN", P: "ZZWADJP", R: "ZZWADJR", D: "ZZWADJD" };
    for (const id of Object.values(C)) await mkUser(id, "client");
    const C_OTHER = "ZZWADJOTH";
    await mkUser(C_OTHER, "client", OTHER_CO);
    const clientAuth = (id: string) => ({ userId: id, companyId: CO, role: "client", name: "", agentId: null });

    const balanceOf = async (clientId: string): Promise<string | null> => {
      const a = await db.clientWalletAccount.findUnique({ where: { clientId_currency: { clientId, currency: "CNY" } }, select: { balance: true } });
      return a ? Number(a.balance).toFixed(2) : null;
    };
    const ledgerOf = (clientId: string) => db.consolidationBalanceLedger.findMany({ where: { clientId }, orderBy: [{ txId: "asc" }, { createdAt: "asc" }, { id: "asc" }] });
    async function assertLedgerMatchesBalance(clientId: string): Promise<void> {
      const rows: Row[] = await ledgerOf(clientId);
      const sum = rows.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0);
      assert.equal((sum / 100).toFixed(2), (await balanceOf(clientId)) ?? "0.00", `${clientId} 流水加起来跟余额对不上`);
    }
    const topup = (auth: Row, b: Row) => call("POST /admin/wallet/adjustments/topup", auth, b);
    const deduct = (auth: Row, b: Row) => call("POST /admin/wallet/adjustments/deduct", auth, b);
    const reverse = (auth: Row, b: Row) => call("POST /admin/wallet/adjustments/reverse", auth, b);
    async function withWalletHeld<T>(clientId: string, ms: number, fire: () => Promise<T>): Promise<T> {
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => { locked = r; });
      const blocker = raw.$transaction(async (t) => {
        await t.$executeRawUnsafe(`INSERT INTO client_wallet_accounts ("clientId", company_id, currency, balance, updated_at) VALUES ('${clientId}', '${CO}', 'CNY', 0, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`);
        await t.$queryRawUnsafe(`SELECT 1 FROM client_wallet_accounts WHERE "clientId" = '${clientId}' FOR UPDATE`);
        locked();
        await sleep(ms);
      }, { timeout: 15_000 });
      await isLocked;
      const out = fire();
      await blocker;
      return out;
    }
    const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    /* ==================== 迁移 ==================== */
    console.log("\n【迁移文件】");
    await test("M1 上线前的库上连跑两遍不报错；跟 schema.prisma 零差异；上线体检一行不报；CHECK 和外键在", async () => {
      const diff = runPrisma(["migrate", "diff", "--from-url", tmpUrl, "--to-schema-datamodel", SCHEMA, "--script", "--exit-code"], tmpUrl);
      assert.equal(diff.code, 0, `还差这些：\n${diff.out.split("\n").filter((l) => l.trim() && !l.startsWith("--")).slice(0, 12).join("\n")}`);
      const drift = await raw.$queryRawUnsafe<Row[]>(readFileSync(DRIFT, "utf8"));
      assert.equal(drift.length, 0, `上线体检报了：${JSON.stringify(drift).slice(0, 300)}`);
      const cons = await raw.$queryRawUnsafe<Row[]>(`SELECT conname FROM pg_constraint WHERE conrelid = 'wallet_adjustments'::regclass ORDER BY conname`);
      assert.deepEqual(cons.map((c) => c.conname), ["wallet_adjustments_client_id_fkey", "wallet_adjustments_pkey", "wallet_adjustments_reverse_shape", "wallet_adjustments_shape"]);
      // CHECK 拦得住：冲掉那几列只填一半、减金额被冲掉、金额 0
      const N7 = "NULL,NULL,NULL,NULL,NULL,NULL,NULL";
      for (const bad of [
        `('zzb1','${CO}','${C.A}','topup',10,'k1','o','o','L',10,NULL,NULL,NULL,NULL,NULL,'rk1',NULL)`,
        `('zzb2','${CO}','${C.A}','deduction',10,'k2','o','o','L',10,now(),'o','o','r','L2','rk2',0)`,
        `('zzb3','${CO}','${C.A}','topup',0,'k3','o','o','L',10,${N7})`,
        `('zzb4','${CO}','${C.A}','other',1,'k4','o','o','L',10,${N7})`,
      ]) {
        await assert.rejects(raw.$executeRawUnsafe(`INSERT INTO wallet_adjustments (id, company_id, client_id, kind, amount, submit_key, operator_id, operator_name, ledger_id, balance_after, reversed_at, reversed_by_id, reversed_by_name, reverse_reason, reversal_ledger_id, reverse_submit_key, reverse_balance_after) VALUES ${bad}`), /check constraint|violates/i, bad);
      }
      // 对照：合规的一行进得去（证明上面是被 CHECK 拦的，不是语句写错）
      await raw.$executeRawUnsafe(`INSERT INTO wallet_adjustments (id, company_id, client_id, kind, amount, submit_key, operator_id, operator_name, ledger_id, balance_after, reversed_at, reversed_by_id, reversed_by_name, reverse_reason, reversal_ledger_id, reverse_submit_key, reverse_balance_after) VALUES ('zzok','${CO}','${C.A}','topup',1,'kok','o','o','L',1,${N7})`);
      await raw.$executeRawUnsafe(`DELETE FROM wallet_adjustments WHERE id = 'zzok'`);
    });

    /* ==================== 加金额 ==================== */
    console.log("\n【加金额】");
    let firstTopup: Row = {};
    await test("T1 管理员给客户加金额：余额马上加；流水 topup（正数、admin_adjust、ref_id = 调整单号、备注、操作人是这个管理员）；调整单记底", async () => {
      const k = newKey();
      const d = await ok200(topup(ADMIN, { clientId: C.A, amount: "5000", remark: "线下转账 11-27", submitKey: k }));
      firstTopup = d;
      assert.equal(d.duplicate, false);
      assert.equal(d.balanceAfter, 5000);
      assert.match(d.adjustment.id, /^adj_/);
      assert.equal(d.adjustment.amount, 5000);
      assert.equal(d.adjustment.hasProof, false);
      assert.equal(await balanceOf(C.A), "5000.00");
      const l = (await ledgerOf(C.A))[0];
      assert.equal(l.type, "topup");
      assert.equal(Number(l.amount), 5000);
      assert.equal(l.refType, "admin_adjust");
      assert.equal(l.refId, d.adjustment.id);
      assert.equal(l.refNo, null);
      assert.equal(l.remark, "线下转账 11-27");
      assert.equal(l.operatorId, ADMIN.userId);
      assert.equal(l.operatorName, ADMIN.name);
      const adj = await db.walletAdjustment.findUnique({ where: { id: d.adjustment.id } });
      assert.equal(adj.kind, "topup");
      assert.equal(adj.submitKey, k);
      assert.equal(adj.ledgerId, l.id);
      assert.equal(adj.operatorName, ADMIN.name);
      assert.equal(adj.reversedAt, null);
    });
    await test("T2 带水单：存下来、只有管理员取得到；水单格式不对 / 不是图 / 太大 → 400，一分没加、编号没记", async () => {
      const d = await ok200(topup(ADMIN, { clientId: C.A, amount: "1.00", proofImage: PNG, submitKey: newKey() }));
      assert.equal(d.adjustment.hasProof, true);
      const p = await ok200(call("GET /admin/wallet/adjustments/proof", ADMIN, {}, { id: d.adjustment.id }));
      assert.equal(p.proofImage, PNG);
      assert.equal((await call("GET /admin/wallet/adjustments/proof", STAFF, {}, { id: d.adjustment.id })).status, 403);
      assert.equal((await call("GET /admin/wallet/adjustments/proof", OTHER_ADMIN, {}, { id: d.adjustment.id })).status, 404);
      const before = await balanceOf(C.A);
      for (const bad of ["javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", 'x" onerror="alert(1)', "data:image/svg+xml;base64,PHN2Zz4=", "/images/../../etc/passwd", `data:image/png;base64,${"A".repeat(8 * 1024 * 1024)}`, 12]) {
        const k = newKey();
        const r = await topup(ADMIN, { clientId: C.A, amount: "1.00", proofImage: bad, submitKey: k });
        assert.equal(r.status, 400, String(bad).slice(0, 40));
        assert.equal(await db.walletAdjustment.findUnique({ where: { submitKey: k } }), null);
      }
      assert.equal(await balanceOf(C.A), before);
    });
    await test("T3 金额 / 备注 / 提交编号格式不对 → 400，什么都没写；金额框里填的是 0、负数、三位小数、字母都不行", async () => {
      const before = await db.walletAdjustment.count();
      for (const b of [
        { clientId: C.A, amount: "0", submitKey: newKey() }, { clientId: C.A, amount: "-1", submitKey: newKey() }, { clientId: C.A, amount: "1.005", submitKey: newKey() },
        { clientId: C.A, amount: "abc", submitKey: newKey() }, { clientId: C.A, amount: "", submitKey: newKey() }, { clientId: C.A, submitKey: newKey() },
        { clientId: C.A, amount: "1,000", submitKey: newKey() }, { clientId: C.A, amount: "1000000000000", submitKey: newKey() },
        { clientId: C.A, amount: "1.00", remark: "x".repeat(201), submitKey: newKey() }, { clientId: C.A, amount: "1.00", remark: 12, submitKey: newKey() },
        { clientId: C.A, amount: "1.00" }, { clientId: C.A, amount: "1.00", submitKey: "short" }, { clientId: C.A, amount: "1.00", submitKey: "有中文有中文有中文有中文有中文有中文" },
        { clientId: "", amount: "1.00", submitKey: newKey() },
      ]) {
        const r = await topup(ADMIN, b);
        assert.equal(r.status, 400, JSON.stringify(b).slice(0, 80));
      }
      assert.equal(await db.walletAdjustment.count(), before);
    });
    await test("T4 同一个提交编号连点两下（6 个真并发）：只加一笔，6 个都 200，1 个是第一次、5 个是重复，数一样", async () => {
      const before = Number(await balanceOf(C.B) ?? 0);
      const k = newKey();
      const rs = await withWalletHeld(C.B, 500, () => Promise.all(Array.from({ length: 6 }, () => topup(ADMIN, { clientId: C.B, amount: "300.00", remark: "连点", submitKey: k }))));
      for (const r of rs) assert.equal(r.status, 200, r.out?.message);
      assert.equal(rs.filter((r) => r.out.data.duplicate === false).length, 1);
      assert.equal(new Set(rs.map((r) => `${r.out.data.adjustment.id}|${r.out.data.balanceAfter}`)).size, 1);
      assert.equal(await balanceOf(C.B), (before + 300).toFixed(2));
      assert.equal(await db.walletAdjustment.count({ where: { submitKey: k } }), 1);
      assert.equal((await ledgerOf(C.B)).filter((l: Row) => l.type === "topup").length, 1);
      await assertLedgerMatchesBalance(C.B);
    });
    await test("T5 同一个提交编号、内容不一样（金额 / 客户 / 备注 / 拿去减金额）→ 409，不动钱", async () => {
      const k = newKey();
      await ok200(topup(ADMIN, { clientId: C.B, amount: "10.00", submitKey: k }));
      const before = await balanceOf(C.B);
      for (const r of await Promise.all([
        topup(ADMIN, { clientId: C.B, amount: "10.01", submitKey: k }),
        topup(ADMIN, { clientId: C.A, amount: "10.00", submitKey: k }),
        topup(ADMIN, { clientId: C.B, amount: "10.00", remark: "改了备注", submitKey: k }),
        deduct(ADMIN, { clientId: C.B, amount: "10.00", reason: "x", submitKey: k }),
      ])) assert.equal(r.status, 409, r.out?.message);
      assert.equal(await balanceOf(C.B), before);
      const again = await ok200(topup(ADMIN, { clientId: C.B, amount: "10", submitKey: k }));
      assert.equal(again.duplicate, true, "10 和 10.00 是同一个数");
    });
    await test("T6 员工 / 客户调加减冲 → 403；别家公司的客户、员工号、不存在的唛头 → 404；什么都没写", async () => {
      const before = await db.walletAdjustment.count();
      for (const who of [STAFF, clientAuth(C.A)]) {
        assert.equal((await topup(who, { clientId: C.A, amount: "1.00", submitKey: newKey() })).status, 403);
        assert.equal((await deduct(who, { clientId: C.A, amount: "1.00", reason: "x", submitKey: newKey() })).status, 403);
        assert.equal((await reverse(who, { adjustmentId: firstTopup.adjustment.id, clientId: C.A, reason: "x", submitKey: newKey() })).status, 403);
      }
      for (const id of [C_OTHER, STAFF.userId, "ZZ_NOBODY"]) assert.equal((await topup(ADMIN, { clientId: id, amount: "1.00", submitKey: newKey() })).status, 404, id);
      assert.equal((await topup(OTHER_ADMIN, { clientId: C.A, amount: "1.00", submitKey: newKey() })).status, 404, "别家公司的管理员加不了这家的客户");
      assert.equal(await db.walletAdjustment.count(), before);
      assert.equal(await balanceOf(C_OTHER), null);
    });

    /* ==================== 减金额 ==================== */
    console.log("\n【减金额】");
    await test("D1 减金额：余额减掉，流水 deduction（负数、原因、操作人）；必须写原因", async () => {
      await ok200(topup(ADMIN, { clientId: C.D, amount: "100.00", submitKey: newKey() }));
      assert.equal((await deduct(ADMIN, { clientId: C.D, amount: "10.00", submitKey: newKey() })).status, 400, "没写原因");
      assert.equal((await deduct(ADMIN, { clientId: C.D, amount: "10.00", reason: "   ", submitKey: newKey() })).status, 400, "原因只有空格");
      assert.equal((await deduct(ADMIN, { clientId: C.D, amount: "10.00", reason: "x", proofImage: PNG, submitKey: newKey() })).status, 400, "减金额不收水单");
      const d = await ok200(deduct(ADMIN, { clientId: C.D, amount: "30.00", reason: "客户要回 30", submitKey: newKey() }));
      assert.equal(d.balanceAfter, 70);
      assert.equal(d.adjustment.kind, "deduction");
      const l = (await ledgerOf(C.D)).at(-1);
      assert.equal(l.type, "deduction");
      assert.equal(Number(l.amount), -30);
      assert.equal(l.remark, "客户要回 30");
      assert.equal(l.refType, "admin_adjust");
      assert.equal(l.refId, d.adjustment.id);
      await assertLedgerMatchesBalance(C.D);
    });
    await test("D2 减成负数：整笔拒绝（400 写清现在多少），一分不动、编号不记；从没有钱包的客户减也拒", async () => {
      const k = newKey();
      const r = await deduct(ADMIN, { clientId: C.D, amount: "70.01", reason: "多减了", submitKey: k });
      assert.equal(r.status, 400);
      assert.match(r.out.message, /余额不够减：现在 ¥70\.00，要减 ¥70\.01/);
      assert.equal(await balanceOf(C.D), "70.00");
      assert.equal(await db.walletAdjustment.findUnique({ where: { submitKey: k } }), null);
      const r2 = await deduct(ADMIN, { clientId: C.N, amount: "1.00", reason: "x", submitKey: newKey() });
      assert.equal(r2.status, 400);
      // 正好减到 0 可以
      await ok200(deduct(ADMIN, { clientId: C.D, amount: "70.00", reason: "全退", submitKey: newKey() }));
      assert.equal(await balanceOf(C.D), "0.00");
    });
    await test("D3 两笔减金额同时来（各 70，余额 100）：只成一笔，另一笔余额不够被拒，余额不会成负数", async () => {
      await ok200(topup(ADMIN, { clientId: C.D, amount: "100.00", submitKey: newKey() }));
      const rs = await withWalletHeld(C.D, 500, () => Promise.all([
        deduct(ADMIN, { clientId: C.D, amount: "70.00", reason: "a", submitKey: newKey() }),
        deduct(ADMIN2, { clientId: C.D, amount: "70.00", reason: "b", submitKey: newKey() }),
      ]));
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 400], rs.map((r) => r.out?.message).join(" | "));
      assert.equal(await balanceOf(C.D), "30.00");
      await assertLedgerMatchesBalance(C.D);
    });

    /* ==================== 冲掉 ==================== */
    console.log("\n【冲掉】");
    await test("R1 冲掉一笔管理员充值：整笔、流水 topup_reversal（负数、挂原来那张单、原因、操作人）；调整单记谁 / 何时 / 为什么", async () => {
      const t = await ok200(topup(ADMIN, { clientId: C.R, amount: "500.00", remark: "打错了", submitKey: newKey() }));
      const k = newKey();
      assert.equal((await reverse(ADMIN2, { adjustmentId: t.adjustment.id, clientId: C.R, reason: "", submitKey: k })).status, 400, "必须写原因");
      const d = await ok200(reverse(ADMIN2, { adjustmentId: t.adjustment.id, clientId: C.R, reason: "多打了一个 0", submitKey: k }));
      assert.equal(d.amount, 500);
      assert.equal(d.balanceAfter, 0);
      assert.equal(d.duplicate, false);
      const l = (await ledgerOf(C.R)).at(-1);
      assert.equal(l.type, "topup_reversal");
      assert.equal(Number(l.amount), -500);
      assert.equal(l.refType, "admin_adjust");
      assert.equal(l.refId, t.adjustment.id, "挂在原来那张充值单上");
      assert.equal(l.remark, "多打了一个 0");
      assert.equal(l.operatorName, ADMIN2.name);
      const adj = await db.walletAdjustment.findUnique({ where: { id: t.adjustment.id } });
      assert.ok(adj.reversedAt);
      assert.equal(adj.reversedById, ADMIN2.userId);
      assert.equal(adj.reversedByName, ADMIN2.name);
      assert.equal(adj.reverseReason, "多打了一个 0");
      assert.equal(adj.reversalLedgerId, l.id);
      // 同一个提交编号再来：回第一次的结果
      const again = await ok200(reverse(ADMIN2, { adjustmentId: t.adjustment.id, clientId: C.R, reason: "多打了一个 0", submitKey: k }));
      assert.equal(again.duplicate, true);
      // 换一个编号再冲：已经冲过 409
      const twice = await reverse(ADMIN, { adjustmentId: t.adjustment.id, clientId: C.R, reason: "再冲", submitKey: newKey() });
      assert.equal(twice.status, 409);
      assert.equal(await balanceOf(C.R), "0.00");
      await assertLedgerMatchesBalance(C.R);
    });
    await test("R2 只有管理员充值能冲（减金额、不存在的、别家公司的不行）；客户对不上 400；同号拿去冲别的 409", async () => {
      const ded = await db.walletAdjustment.findFirst({ where: { kind: "deduction", clientId: C.D } });
      assert.equal((await reverse(ADMIN, { adjustmentId: ded.id, clientId: C.D, reason: "x", submitKey: newKey() })).status, 400);
      assert.equal((await reverse(ADMIN, { adjustmentId: "adj_nope", clientId: C.D, reason: "x", submitKey: newKey() })).status, 404);
      assert.equal((await reverse(OTHER_ADMIN, { adjustmentId: firstTopup.adjustment.id, clientId: C.A, reason: "x", submitKey: newKey() })).status, 404);
      assert.equal((await reverse(ADMIN, { adjustmentId: firstTopup.adjustment.id, clientId: C.B, reason: "x", submitKey: newKey() })).status, 400);
      assert.equal((await reverse(ADMIN, { adjustmentId: firstTopup.adjustment.id, clientId: C.A, reason: "x" })).status, 400, "没带提交编号");
      assert.equal((await db.walletAdjustment.findUnique({ where: { id: firstTopup.adjustment.id } })).reversedAt, null);
    });
    await test("R3 两个管理员同时冲同一笔（各自的编号）：只冲一次，另一个 409，余额只少一次", async () => {
      const t = await ok200(topup(ADMIN, { clientId: C.R, amount: "200.00", submitKey: newKey() }));
      const rs = await withWalletHeld(C.R, 500, () => Promise.all([
        reverse(ADMIN, { adjustmentId: t.adjustment.id, clientId: C.R, reason: "甲冲", submitKey: newKey() }),
        reverse(ADMIN2, { adjustmentId: t.adjustment.id, clientId: C.R, reason: "乙冲", submitKey: newKey() }),
      ]));
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409], rs.map((r) => r.out?.message).join(" | "));
      assert.equal(await balanceOf(C.R), "0.00");
      assert.equal((await ledgerOf(C.R)).filter((l: Row) => l.type === "topup_reversal" && l.refId === t.adjustment.id).length, 1);
      await assertLedgerMatchesBalance(C.R);
    });
    await test("R4 同一个冲掉编号 6 个一起来：只冲一次", async () => {
      const t = await ok200(topup(ADMIN, { clientId: C.R, amount: "50.00", submitKey: newKey() }));
      const k = newKey();
      const rs = await withWalletHeld(C.R, 500, () => Promise.all(Array.from({ length: 6 }, () => reverse(ADMIN, { adjustmentId: t.adjustment.id, clientId: C.R, reason: "连点", submitKey: k }))));
      for (const r of rs) assert.equal(r.status, 200, r.out?.message);
      assert.equal(rs.filter((r) => r.out.data.duplicate === false).length, 1);
      assert.equal(await balanceOf(C.R), "0.00");
    });
    await test("R5 冲成负数：钱已经被集货付款花掉了也照冲 → 负数；负数时客户付集货拼柜被拒（余额不足）、财务来扣扣 0", async () => {
      const t = await ok200(topup(ADMIN, { clientId: C.P, amount: "100.00", submitKey: newKey() }));
      const task = await db.consolidationTask.create({ data: { taskNo: "JHZZW0001", companyId: CO, clientId: C.P, destinationTh: "-", status: "quoted", totalFee: "80.00" } });
      await ok200(call("POST /client/consolidation/pay", clientAuth(C.P), { taskId: task.id }));
      assert.equal(await balanceOf(C.P), "20.00");
      const d = await ok200(reverse(ADMIN, { adjustmentId: t.adjustment.id, clientId: C.P, reason: "钱没到账", submitKey: newKey() }));
      assert.equal(d.balanceAfter, -80);
      assert.equal(await balanceOf(C.P), "-80.00");
      const task2 = await db.consolidationTask.create({ data: { taskNo: "JHZZW0002", companyId: CO, clientId: C.P, destinationTh: "-", status: "quoted", totalFee: "1.00" } });
      const pay = await call("POST /client/consolidation/pay", clientAuth(C.P), { taskId: task2.id });
      assert.equal(pay.status, 400);
      assert.match(pay.out.message, /余额不足/);
      const ch = await f2("POST", "/charges", { requestId: "zz-wadj-r5", customerMark: C.P, billNo: "B-R5", billKind: "bulk", maxAmount: "10.00" });
      assert.equal(ch.status, 200);
      assert.equal(ch.body.charged, "0.00");
      assert.equal(ch.body.balanceAfter, "-80.00");
      // 再加金额：先补窟窿
      const fill = await ok200(topup(ADMIN, { clientId: C.P, amount: "100.00", submitKey: newKey() }));
      assert.equal(fill.balanceAfter, 20);
      await assertLedgerMatchesBalance(C.P);
    });
    await test("R6 加金额和客户付集货拼柜同时来（钱包先被锁住再一起放开）：余额对、流水对", async () => {
      // C.P 现在 20
      const tasks: Row[] = [];
      for (let i = 0; i < 4; i++) tasks.push(await db.consolidationTask.create({ data: { taskNo: `JHZZW1${i}`, companyId: CO, clientId: C.P, destinationTh: "-", status: "quoted", totalFee: "15.00" } }));
      const rs = await withWalletHeld(C.P, 500, () => Promise.all([
        ...tasks.map((t) => call("POST /client/consolidation/pay", clientAuth(C.P), { taskId: t.id })),
        ...Array.from({ length: 4 }, () => topup(ADMIN, { clientId: C.P, amount: "10.00", submitKey: newKey() })),
      ]));
      const paid = rs.slice(0, 4).filter((r) => r.status === 200).length * 15;
      for (const r of rs.slice(4)) assert.equal(r.status, 200, r.out?.message);
      for (const r of rs.slice(0, 4)) assert.ok(r.status === 200 || /余额不足/.test(r.out?.message ?? ""), r.out?.message);
      assert.equal(await balanceOf(C.P), (20 + 40 - paid).toFixed(2));
      assert.ok(Number(await balanceOf(C.P)) >= 0);
      await assertLedgerMatchesBalance(C.P);
    });

    /* ==================== 看流水 ==================== */
    console.log("\n【按客户看流水】");
    await test("V1 员工 / 管理员按客户看流水：中文类型名、来源「后台调整」；管理员看得到操作人、谁冲的，员工看不到；冲掉 / 水单的标记对", async () => {
      const a = await ok200(call("GET /staff/wallet/ledger", ADMIN, {}, { clientId: C.R, pageSize: "50" }));
      const s = await ok200(call("GET /staff/wallet/ledger", STAFF, {}, { clientId: C.R, pageSize: "50" }));
      assert.equal(a.total, s.total);
      const topupRow = a.items.find((i: Row) => i.type === "topup" && i.adjustment?.reversed);
      assert.equal(topupRow.typeLabel, "管理员充值");
      assert.equal(topupRow.source, "后台调整");
      assert.equal(topupRow.operatorName, ADMIN.name);
      assert.equal(topupRow.adjustment.canReverse, false);
      assert.ok(topupRow.adjustment.reversed.byName);
      const revRow = a.items.find((i: Row) => i.type === "topup_reversal");
      assert.equal(revRow.typeLabel, "冲掉充值");
      assert.equal(revRow.adjustment.canReverse, false, "冲掉那一行不出「冲掉」");
      for (const i of s.items) {
        assert.equal("operatorName" in i && i.operatorName !== undefined, false, "员工看不到操作人");
        if (i.adjustment?.reversed) assert.equal(i.adjustment.reversed.byName, undefined, "员工看不到谁冲的");
      }
      const live = (await ok200(call("GET /staff/wallet/ledger", ADMIN, {}, { clientId: C.A }))).items.find((i: Row) => i.adjustment?.id === firstTopup.adjustment.id);
      assert.equal(live.adjustment.canReverse, true);
      const withProof = (await ok200(call("GET /staff/wallet/ledger", ADMIN, {}, { clientId: C.A }))).items.find((i: Row) => i.adjustment?.hasProof);
      assert.ok(withProof, "带水单那一笔 hasProof");
      assert.equal((await call("GET /staff/wallet/ledger", ADMIN, {}, { clientId: C_OTHER })).status, 404);
      assert.equal((await call("GET /staff/wallet/ledger", clientAuth(C.A), {}, { clientId: C.A })).status, 403);
      assert.equal((await call("GET /staff/wallet/ledger", ADMIN, {}, { clientId: C.A, page: "0" })).status, 400);
    });
    await test("V2 客户列表：没钱包的给 0、负数照给；按唛头搜；只给唛头不给名字；员工也能看、客户不能", async () => {
      const all = await ok200(call("GET /staff/wallet/clients", STAFF));
      const ids = all.clients.map((c: Row) => c.clientId);
      assert.ok(ids.includes(C.N) && !ids.includes(C_OTHER) && !ids.includes(STAFF.userId));
      assert.deepEqual(Object.keys(all.clients[0]).sort(), ["balance", "clientId", "status", "updatedAt"]);
      assert.equal(all.clients.find((c: Row) => c.clientId === C.N).balance, 0);
      assert.equal(all.clients.find((c: Row) => c.clientId === C.N).updatedAt, null);
      const found = await ok200(call("GET /staff/wallet/clients", ADMIN, {}, { keyword: "wadjr" }));
      assert.deepEqual(found.clients.map((c: Row) => c.clientId), [C.R]);
      assert.ok(!JSON.stringify(all).includes("名字"), "不带客户名字");
      assert.equal((await call("GET /staff/wallet/clients", clientAuth(C.A))).status, 403);
    });
    await test("V3 客户自己的余额页：管理员充值 / 冲掉充值 / 管理员减金额都是中文，来源「后台调整」，备注原样；页面上没有英文类型名", async () => {
      const r = await ok200(call("GET /client/wallet/ledger", clientAuth(C.R), {}, { pageSize: "100" }));
      const labels = new Set(r.items.map((i: Row) => i.typeLabel));
      assert.ok(labels.has("管理员充值") && labels.has("冲掉充值"));
      for (const i of r.items) {
        assert.doesNotMatch(`${i.typeLabel}${i.source}`, /[A-Za-z_]{3,}/, `${i.typeLabel} / ${i.source}`);
        if (i.type === "topup_reversal") assert.equal(i.source, "后台调整");
      }
      assert.ok(r.items.some((i: Row) => i.remark === "多打了一个 0"));
      const d = await ok200(call("GET /client/wallet/ledger", clientAuth(C.D), {}, { pageSize: "100" }));
      assert.ok(d.items.some((i: Row) => i.typeLabel === "管理员减金额" && i.remark === "客户要回 30"));
      // 认不出来的类型 / 来源：写「其他」，不漏英文
      await raw.$executeRawUnsafe(`INSERT INTO consolidation_balance_ledger (id, company_id, client_id, type, amount, balance_after, ref_type) VALUES ('zzweird', '${CO}', '${C.N}', 'weird_type', 0.01, 0.01, 'weird_ref')`);
      const w = await ok200(call("GET /client/wallet/ledger", clientAuth(C.N)));
      assert.equal(w.items[0].typeLabel, "其他");
      assert.equal(w.items[0].source, "其他");
      await raw.$executeRawUnsafe(`DELETE FROM consolidation_balance_ledger WHERE id = 'zzweird'`);
    });
    await test("V4 财务系统2 拉 /ledger：三种流水 refType = admin_adjust、refId = adj_…、remark 原样、operatorName = 做这件事的管理员", async () => {
      const items: Row[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 50; i++) {
        const r = await f2("GET", `/ledger?limit=500${cursor ? `&cursor=${cursor}` : ""}`);
        assert.equal(r.status, 200);
        items.push(...r.body.items);
        cursor = r.body.nextCursor;
        if (!r.body.hasMore) break;
      }
      const mine = items.filter((i) => i.customerMark === C.R || i.customerMark === C.D);
      const topupRow = mine.find((i) => i.type === "topup")!;
      assert.equal(topupRow.refType, "admin_adjust");
      assert.match(topupRow.refId, /^adj_/);
      assert.equal(topupRow.refNo, null);
      assert.equal(topupRow.operatorName, ADMIN.name);
      const rev = mine.find((i) => i.type === "topup_reversal" && i.remark === "多打了一个 0")!;
      assert.equal(rev.operatorName, ADMIN2.name);
      assert.equal(rev.amount, "-500.00");
      const ded = mine.find((i) => i.type === "deduction" && i.remark === "客户要回 30")!;
      assert.equal(ded.amount, "-30.00");
      assert.equal(ded.refType, "admin_adjust");
    });

    /* ==================== 老路 ==================== */
    console.log("\n【老路照旧】");
    await test("O1 客户提交充值 → 管理员通过：照旧进余额、记「充值到账」流水；拒绝照旧", async () => {
      const sub = await ok200(call("POST /client/wallet/recharge", clientAuth(C.N), { amount: 66, paymentMethod: "WECHAT", proofImage: PNG }));
      assert.match(sub.message, /通过后才会进余额/);
      await ok200(call("POST /admin/wallet/recharges/approve", ADMIN, { id: sub.id }));
      assert.equal(await balanceOf(C.N), "66.00");
      const l = (await ledgerOf(C.N)).at(-1);
      assert.equal(l.type, "recharge");
      assert.equal(l.refType, "recharge");
      const sub2 = await ok200(call("POST /client/wallet/recharge", clientAuth(C.N), { amount: 5, paymentMethod: "WECHAT", proofImage: PNG }));
      await ok200(call("POST /admin/wallet/recharges/reject", ADMIN, { id: sub2.id, reviewRemark: "没收到" }));
      assert.equal(await balanceOf(C.N), "66.00");
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
