/**
 * 回归测试：钱包行第一次出现的那一刻，集货付款 / 退款不许把别人刚加进来的钱整行写回盖掉（2026-11-27 修）。
 *
 * 原来的问题（wallet/consolidation-balance.ts 的 chargeForConsolidation / refundToConsolidation）：
 *   先锁（SELECT … FOR UPDATE，没行就什么也没锁住）→ 再另外读余额（不加锁）→ 按读到的数整行写回。
 *   客户从没有过钱包行时：① 第一笔充值通过（建出行 1000）落在「锁」和「读」之间，付款读到 1000；
 *   ② 第二笔充值通过（行上 +1000）落在「读」和「写」之间，付款手里没锁、挡不住；③ 付款整行写成 900 —— 余额 900、流水合计 1900。
 * 修法：锁和读是同一句（lockAndReadBalance），锁不到行 = 这一刻余额就是 0；退款锁不到行时先建行再锁。
 *
 * 真库、真代码，充值走真的「通过充值」接口（管理员）：
 *   A1 付款强制时序：在付款的「锁」之后插第一笔充值、「读」之后插第二笔（新代码没有第二次读，就在付款结束后再通过）——
 *      余额必须等于流水合计；修之前这一条红（900 vs 1900），修之后付款当场余额不足、两笔充值都在（2000）
 *   A2 退款强制时序：同样的插法 —— 余额等于流水合计，修之前红
 *   B  对照：钱包行本来就在，同样在付款事务里发出两笔充值（不等）—— 一直是对的（锁挡得住）
 *   C  不强制时序：付款 + 两笔充值同时发，跑 KNOWN_ROUNDS 轮（默认 30），每轮余额都等于流水合计
 *
 * 用法：npm run test:wallet-first-row-db（只在本机 / CI 的一次性库上跑：DATABASE_URL 是 localhost + AGENT_PORTAL_TEST_ALLOW_DB=1）
 */
process.env.TZ = "UTC";
process.env.AUTH_SECRET ||= "test-only-fake-secret-not-a-real-key-do-not-use-in-production";
process.env.AGENT_REBATE_SCHEDULER = "off";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";

type Row = Record<string, any>;
const CO = "zz_firstrow_co";
const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "apps/api/prisma/schema.prisma");
const PNG = "data:image/png;base64,iVBORw0KGgo=";

let failures = 0;
let passes = 0;
async function test(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passes++; console.log(`  ✅ ${label}`); }
  catch (e) { failures++; console.log(`  ❌ ${label}\n     ${(e instanceof Error ? e.stack ?? e.message : String(e)).split("\n").slice(0, 8).join("\n     ")}`); }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") { console.log("⚠️ 跳过：怕连到生产库不跑（确认是测试库再设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测"); return; }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(url).hostname)) { console.log("⚠️ 跳过：这一项要临时建库，只在本机 / CI 的一次性库上跑 —— 这一项等于没测"); return; }

  const tmpName = `zz_firstrow_${Date.now().toString(36)}`;
  const tmp = new URL(url);
  tmp.pathname = `/${tmpName}`;
  const admin = new PrismaClient({ datasources: { db: { url } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${tmpName}"`);
  try {
    execFileSync("npx", ["prisma", "db", "push", `--schema=${SCHEMA}`, "--skip-generate"], { cwd: ROOT, env: { ...process.env, DATABASE_URL: tmp.toString() }, stdio: "ignore" });
    process.env.DATABASE_URL = tmp.toString();
    process.env.NODE_ENV = "test";
    process.env.IMAGES_DIR = mkdtempSync(path.join(os.tmpdir(), "zz-firstrow-img-"));
    const { prisma } = await import("../apps/api/src/db/prisma");
    const wallet = await import("../apps/api/src/modules/wallet/consolidation-balance");
    const db = prisma as any;

    const routes = new Map<string, Function>();
    const fake: any = {};
    for (const m of ["get", "post", "delete"]) fake[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
    (await import("../apps/api/src/modules/admin/routes")).registerAdminRoutes(fake);
    const ADMIN = { userId: "zz_firstrow_admin", companyId: CO, role: "admin", name: "管理员", agentId: null };
    await db.user.create({ data: { id: ADMIN.userId, companyId: CO, role: "admin", name: "管理员", phone: "0", status: "active", passwordHash: "x" } });
    async function approve(id: string): Promise<number> {
      let status = 200;
      const res: any = { status(s: number) { status = s; return res; }, json() {}, setHeader() {} };
      await routes.get("POST /admin/wallet/recharges/approve")!({ method: "POST", body: { id }, query: {}, headers: {}, auth: ADMIN, path: "/admin/wallet/recharges/approve" }, res);
      return status;
    }
    let n = 0;
    async function freshClient(withRow: string | null): Promise<{ client: string; r1: string; r2: string }> {
      const client = `ZZFR${(++n).toString().padStart(4, "0")}`;
      await db.user.create({ data: { id: client, companyId: CO, role: "client", name: "x", phone: "0", status: "active", passwordHash: "x" } });
      if (withRow !== null) {
        await db.clientWalletAccount.create({ data: { clientId: client, companyId: CO, currency: "CNY", balance: withRow } });
        await db.consolidationBalanceLedger.create({ data: { companyId: CO, clientId: client, type: "recharge", amount: withRow, balanceAfter: withRow, refType: "seed", refId: client } });
      }
      const mk = async (i: number) => (await db.walletRecharge.create({ data: { id: `rcg_zz_${client}_${i}`, companyId: CO, clientId: client, currency: "CNY", amount: "1000.00", paymentMethod: "WECHAT", proofImage: PNG, status: "PENDING" } })).id as string;
      return { client, r1: await mk(1), r2: await mk(2) };
    }
    const state = async (client: string) => {
      const acc = await db.clientWalletAccount.findUnique({ where: { clientId_currency: { clientId: client, currency: "CNY" } } });
      const rows: Row[] = await db.consolidationBalanceLedger.findMany({ where: { clientId: client } });
      return { balance: acc ? Number(acc.balance).toFixed(2) : "（没有钱包行）", ledgerSum: (Math.round(rows.reduce((s, r) => s + Number(r.amount) * 100, 0)) / 100).toFixed(2) };
    };
    /**
     * 用真的 chargeForConsolidation / refundToConsolidation，跑在包了一层的事务上：
     * 第一句手写 SQL（锁）之后跑一次 afterLock、读余额（findUnique）之后跑一次 afterRead —— 各只跑一次。
     * 新代码锁和读是同一句、不再 findUnique：afterRead 没机会跑，就在事务结束后跑（照样是「第二笔充值」）。
     */
    async function runWithHooks(kind: "pay" | "refund", client: string, amount: number, hooks: { afterLock?: () => Promise<unknown>; afterRead?: () => Promise<unknown> }): Promise<string> {
      let lockDone = false;
      let readDone = false;
      let result: string;
      try {
        await prisma.$transaction(async (tx) => {
          const t = tx as any;
          const wrapped = {
            $queryRaw: async (...args: any[]) => {
              const r = await t.$queryRaw(...args);
              if (!lockDone) { lockDone = true; if (hooks.afterLock) await hooks.afterLock(); }
              return r;
            },
            clientWalletAccount: {
              findUnique: async (a: any) => {
                const r = await t.clientWalletAccount.findUnique(a);
                if (!readDone) { readDone = true; if (hooks.afterRead) await hooks.afterRead(); }
                return r;
              },
              update: (a: any) => t.clientWalletAccount.update(a),
              upsert: (a: any) => t.clientWalletAccount.upsert(a),
            },
            consolidationBalanceLedger: { create: (a: any) => t.consolidationBalanceLedger.create(a) },
          };
          const args = { companyId: CO, clientId: client, amount, refType: "normal", refId: `zz_task_${client}`, refNo: "JH-ZZ", remark: kind === "pay" ? "集货付款" : "撤销付款退款", operatorId: ADMIN.userId, operatorName: "管理员" };
          if (kind === "pay") await wallet.chargeForConsolidation(wrapped as any, args);
          else await wallet.refundToConsolidation(wrapped as any, args);
        }, { maxWait: 10_000, timeout: 30_000 });
        result = "成功";
      } catch (e) {
        result = e instanceof wallet.InsufficientBalanceError ? "余额不足" : `出错：${(e as Error).message}`;
      }
      if (!readDone && hooks.afterRead) await hooks.afterRead();
      return result;
    }

    console.log("\n【强制时序：钱包行原来不存在】");
    await test("A1 付款：锁之后通过第一笔充值、读之后通过第二笔 —— 余额等于流水合计（修之前余额 900、流水 1900）", async () => {
      const c = await freshClient(null);
      const out = await runWithHooks("pay", c.client, 100, {
        afterLock: async () => { assert.equal(await approve(c.r1), 200); },
        afterRead: async () => { assert.equal(await approve(c.r2), 200); },
      });
      const s = await state(c.client);
      console.log(`     付款：${out}；余额 ¥${s.balance}，流水合计 ¥${s.ledgerSum}`);
      assert.equal(s.balance, s.ledgerSum, "余额跟流水对不上：有一笔充值被付款整行写回盖掉了");
      assert.equal(s.balance, out === "成功" ? "1900.00" : "2000.00");
      assert.ok(out === "成功" || out === "余额不足", out);
    });
    await test("A2 退款：同样的插法 —— 余额等于流水合计（修之前退款按读到的数整行写回、盖掉第二笔充值）", async () => {
      const c = await freshClient(null);
      const out = await runWithHooks("refund", c.client, 50, {
        afterLock: async () => { assert.equal(await approve(c.r1), 200); },
        afterRead: async () => { assert.equal(await approve(c.r2), 200); },
      });
      const s = await state(c.client);
      console.log(`     退款：${out}；余额 ¥${s.balance}，流水合计 ¥${s.ledgerSum}`);
      assert.equal(out, "成功");
      assert.equal(s.balance, s.ledgerSum, "余额跟流水对不上");
      assert.equal(s.balance, "2050.00");
    });

    console.log("\n【对照：钱包行本来就在】");
    await test("B 钱包行本来就在（余额 100），付款事务里发出两笔充值（被锁挡住、不等）—— 余额 2000、等于流水合计", async () => {
      const c = await freshClient("100.00");
      const pending: Promise<number>[] = [];
      const out = await runWithHooks("pay", c.client, 100, {
        afterLock: async () => { pending.push(approve(c.r1)); },
        afterRead: async () => { pending.push(approve(c.r2)); },
      });
      assert.deepEqual(await Promise.all(pending), [200, 200]);
      const s = await state(c.client);
      assert.equal(out, "成功");
      assert.equal(s.balance, "2000.00");
      assert.equal(s.ledgerSum, "2000.00");
    });
    await test("B2 正常情况没变：钱包里有钱照常付、退；余额不够照旧报「余额不足：本次需要 ¥x，当前余额 ¥y，还差 ¥z」；从没有钱包行的付款报余额不足、不建行", async () => {
      const c = await freshClient("100.00");
      assert.equal(await runWithHooks("pay", c.client, 30, {}), "成功");
      assert.equal((await state(c.client)).balance, "70.00");
      assert.equal(await runWithHooks("refund", c.client, 30, {}), "成功");
      assert.equal((await state(c.client)).balance, "100.00");
      let msg = "";
      try { await prisma.$transaction((tx) => wallet.chargeForConsolidation(tx as any, { companyId: CO, clientId: c.client, amount: 100.01, refType: "normal", refId: "x", operatorId: null, operatorName: null })); }
      catch (e) { msg = (e as Error).message; }
      assert.equal(msg, "余额不足：本次需要 ¥100.01，当前余额 ¥100.00，还差 ¥0.01");
      const none = await freshClient(null);
      assert.equal(await runWithHooks("pay", none.client, 1, {}), "余额不足");
      assert.equal((await state(none.client)).balance, "（没有钱包行）", "付款不给没钱包的客户建行");
      // 返回值：扣完 / 退完的余额（数字）
      const after = await prisma.$transaction((tx) => wallet.chargeForConsolidation(tx as any, { companyId: CO, clientId: c.client, amount: 12.34, refType: "normal", refId: "y", operatorId: null, operatorName: null }));
      assert.equal(after, 87.66);
      const back = await prisma.$transaction((tx) => wallet.refundToConsolidation(tx as any, { companyId: CO, clientId: c.client, amount: 12.34, refType: "normal", refId: "y", operatorId: null, operatorName: null }));
      assert.equal(back, 100);
    });

    const rounds = Number(process.env.KNOWN_ROUNDS ?? 30);
    console.log(`\n【不强制时序：付款 + 两笔充值同时发，${rounds} 轮】`);
    await test(`C ${rounds} 轮（每轮一个从没有钱包的新客户）：每一轮余额都等于流水合计`, async () => {
      let bad = 0, paid = 0;
      for (let i = 0; i < rounds; i++) {
        const c = await freshClient(null);
        const [p] = await Promise.all([runWithHooks("pay", c.client, 100, {}), approve(c.r1), approve(c.r2)]);
        if (p === "成功") paid++;
        const s = await state(c.client);
        if (s.balance !== s.ledgerSum) bad++;
      }
      console.log(`     付款成功 ${paid} 轮，其余余额不足；对不上 ${bad} 轮`);
      assert.equal(bad, 0);
    });

    await prisma.$disconnect();
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${tmpName}" WITH (FORCE)`);
    await admin.$disconnect();
  }
  console.log(`\n通过 ${passes}，失败 ${failures}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
