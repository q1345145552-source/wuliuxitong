/**
 * 【已知问题，不进 CI 必过组】集货付款「先锁、再另外读余额」：钱包行第一次出现的那一刻可能盖掉一笔充值（2026-11-27 记，没改，总窗口去问老板）。
 *
 * 问题在 wallet/consolidation-balance.ts 的 chargeForConsolidation：
 *   lockAccount()（SELECT … FOR UPDATE）→ readBalance()（另一句 SELECT，不加锁）→ update 写回「算好的绝对值」。
 * 客户从没有过钱包行时，lockAccount 什么也锁不到。要是这时候：
 *   ① 管理员通过第一笔充值（建出钱包行 1000、提交）—— 落在「锁」和「读」之间，付款读到 1000；
 *   ② 管理员通过第二笔充值（行上 +1000、提交）—— 落在「读」和「写」之间，付款手里没锁，挡不住它；
 *   ③ 付款按读到的 1000 算出 900，整行写成 900 —— 第二笔充值的 1000 没了（流水上却记着）。
 *
 * 这个脚本做三件事（真库、真代码，充值走真的「通过充值」接口）：
 *   A 强制时序复现：把付款用的事务包一层，在「锁」之后、「读」之后各插一次真的充值审核，看最后余额对不对；
 *   B 对照：钱包行本来就在时，同样的插法（充值在付款事务提交前发出），余额是对的 —— 说明洞只在「第一次建行」；
 *   C 不强制时序：付款和两笔充值同时发，跑很多轮，数有几轮出错（看自然情况下多难碰上）。
 * 只打印结果，退出码 0（结论写在最后几行）。
 *
 * 用法：DATABASE_URL=<本机一次性库> AGENT_PORTAL_TEST_ALLOW_DB=1 npm run test:wallet-first-row-known-issue-db
 *       可设 KNOWN_ISSUE_ROUNDS=200 改 C 跑几轮（默认 100）
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
const CO = "zz_known_co";
const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "apps/api/prisma/schema.prisma");
const PNG = "data:image/png;base64,iVBORw0KGgo=";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url || process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(url).hostname)) {
    console.log("⚠️ 跳过：要本机一次性库（DATABASE_URL 是 localhost）+ AGENT_PORTAL_TEST_ALLOW_DB=1 —— 这一项等于没测");
    return;
  }
  const tmpName = `zz_known_${Date.now().toString(36)}`;
  const tmp = new URL(url);
  tmp.pathname = `/${tmpName}`;
  const admin = new PrismaClient({ datasources: { db: { url } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${tmpName}"`);
  try {
    execFileSync("npx", ["prisma", "db", "push", `--schema=${SCHEMA}`, "--skip-generate"], { cwd: ROOT, env: { ...process.env, DATABASE_URL: tmp.toString() }, stdio: "ignore" });
    process.env.DATABASE_URL = tmp.toString();
    process.env.NODE_ENV = "test";
    process.env.IMAGES_DIR = mkdtempSync(path.join(os.tmpdir(), "zz-known-img-"));
    const { prisma } = await import("../apps/api/src/db/prisma");
    const wallet = await import("../apps/api/src/modules/wallet/consolidation-balance");
    const db = prisma as any;

    const routes = new Map<string, Function>();
    const fake: any = {};
    for (const m of ["get", "post", "delete"]) fake[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
    (await import("../apps/api/src/modules/admin/routes")).registerAdminRoutes(fake);
    const ADMIN = { userId: "zz_known_admin", companyId: CO, role: "admin", name: "管理员", agentId: null };
    await db.user.create({ data: { id: ADMIN.userId, companyId: CO, role: "admin", name: "管理员", phone: "0", status: "active", passwordHash: "x" } });
    async function approve(id: string): Promise<number> {
      let status = 200;
      const res: any = { status(s: number) { status = s; return res; }, json() {}, setHeader() {} };
      await routes.get("POST /admin/wallet/recharges/approve")!({ method: "POST", body: { id }, query: {}, headers: {}, auth: ADMIN, path: "/admin/wallet/recharges/approve" }, res);
      return status;
    }
    let n = 0;
    async function freshClient(withRow: string | null): Promise<{ client: string; r1: string; r2: string }> {
      const client = `ZZKN${(++n).toString().padStart(4, "0")}`;
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
      return { balance: acc ? Number(acc.balance) : 0, ledgerSum: Math.round(rows.reduce((s, r) => s + Number(r.amount) * 100, 0)) / 100 };
    };
    /** 真的 chargeForConsolidation，跑在一个包了一层的事务上：锁之后、读之后各跑一次钩子 */
    async function payWithHooks(client: string, amount: number, hooks: { afterLock?: () => Promise<unknown>; afterRead?: () => Promise<unknown> }): Promise<string> {
      try {
        await prisma.$transaction(async (tx) => {
          const t = tx as any;
          const wrapped = {
            $queryRaw: async (...args: any[]) => { const r = await t.$queryRaw(...args); if (hooks.afterLock) await hooks.afterLock(); return r; },
            clientWalletAccount: {
              findUnique: async (a: any) => { const r = await t.clientWalletAccount.findUnique(a); if (hooks.afterRead) await hooks.afterRead(); return r; },
              update: (a: any) => t.clientWalletAccount.update(a),
              upsert: (a: any) => t.clientWalletAccount.upsert(a),
            },
            consolidationBalanceLedger: { create: (a: any) => t.consolidationBalanceLedger.create(a) },
          };
          await wallet.chargeForConsolidation(wrapped as any, { companyId: CO, clientId: client, amount, refType: "normal", refId: `zz_task_${client}`, refNo: "JH-ZZ", remark: "集货付款", operatorId: client, operatorName: client });
        }, { maxWait: 10_000, timeout: 30_000 });
        return "付款成功";
      } catch (e) {
        return e instanceof wallet.InsufficientBalanceError ? "余额不足" : `出错：${(e as Error).message}`;
      }
    }

    /* ---------- A 强制时序 ---------- */
    console.log("\n【A 强制时序：钱包行原来不存在】");
    const a = await freshClient(null);
    const aPay = await payWithHooks(a.client, 100, {
      afterLock: async () => { assert.equal(await approve(a.r1), 200); },
      afterRead: async () => { assert.equal(await approve(a.r2), 200); },
    });
    const aState = await state(a.client);
    console.log(`  付款：${aPay}；两笔充值都通过了`);
    console.log(`  最后余额 ¥${aState.balance.toFixed(2)}，流水加起来 ¥${aState.ledgerSum.toFixed(2)}，应该是 ¥1900.00`);
    const reproduced = aPay === "付款成功" && aState.balance !== aState.ledgerSum;
    console.log(reproduced ? "  ❗ 复现了：第二笔充值的钱被付款整行写回盖掉了" : "  没复现");

    /* ---------- B 对照：钱包行本来就在 ---------- */
    console.log("\n【B 对照：钱包行本来就在（余额 100），同样在付款事务里发出两笔充值】");
    const b = await freshClient("100.00");
    const pending: Promise<number>[] = [];
    const bPay = await payWithHooks(b.client, 100, {
      // 行已经被付款锁住：充值会卡在锁上，所以这里只发出去、不等（等的话就是死等）
      afterLock: async () => { pending.push(approve(b.r1)); },
      afterRead: async () => { pending.push(approve(b.r2)); },
    });
    const bStatus = await Promise.all(pending);
    const bState = await state(b.client);
    console.log(`  付款：${bPay}；两笔充值：${bStatus.join(" / ")}`);
    console.log(`  最后余额 ¥${bState.balance.toFixed(2)}，流水加起来 ¥${bState.ledgerSum.toFixed(2)}，应该是 ¥2000.00`);
    const controlOk = bState.balance === bState.ledgerSum && bState.balance === 2000;
    console.log(controlOk ? "  ✅ 对的：行在的时候锁挡得住" : "  ❗ 对照也错了");

    /* ---------- C 不强制时序 ---------- */
    const rounds = Number(process.env.KNOWN_ISSUE_ROUNDS ?? 100);
    console.log(`\n【C 不强制时序：付款 + 两笔充值同时发，跑 ${rounds} 轮（每轮一个从没有钱包的新客户）】`);
    let bad = 0, paid = 0;
    for (let i = 0; i < rounds; i++) {
      const c = await freshClient(null);
      const [p] = await Promise.all([payWithHooks(c.client, 100, {}), approve(c.r1), approve(c.r2)]);
      if (p === "付款成功") paid++;
      const s = await state(c.client);
      if (s.balance !== s.ledgerSum) bad++;
    }
    console.log(`  付款成功 ${paid} 轮（其余是「余额不足」：付款先到、那时还没钱）；余额和流水对不上 ${bad} 轮`);

    console.log("\n【结论】");
    console.log(`  强制时序：${reproduced ? "复现了（代码里确实有这个洞）" : "复现不了"}；对照（行已存在）：${controlOk ? "正确" : "也错"}；自然并发 ${rounds} 轮出错 ${bad} 轮。`);
    await prisma.$disconnect();
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${tmpName}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
