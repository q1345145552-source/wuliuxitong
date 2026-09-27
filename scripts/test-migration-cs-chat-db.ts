/**
 * 真跑一遍 20260928_cs_chat_and_inquiry_quote/migration.sql（2026-09-28 Codex 复核第 14 条）。
 *
 * 为什么要有：CI 的连库测试是拿 schema.prisma 直接 db push 建库，**完全绕过迁移文件** ——
 * 迁移里少一个唯一索引、外键写错，所有测试照样全绿，上线时才炸（比如少了对话的唯一索引，
 * 发第一条消息的 ON CONFLICT (company_id, client_id) 当场报错）。
 *
 * 做法（只在一次性库上跑，要临时建一个数据库）：
 *   1. 新建临时库，按当前 schema.prisma 建好结构；
 *   2. 把这份迁移加的东西拆掉（两张表、询价单 8 列和外键）= 回到上线前的样子；放一条老询价单；
 *   3. 迁移文件连跑两遍（第二遍验证能重复执行）；
 *   4. `prisma migrate diff` 比对库和 schema.prisma：必须一点差异都没有；
 *   5. 老询价单一个字没变；
 *   6. 删掉临时库。
 * 以后 schema.prisma 再加别的字段也不影响这条：第 1 步建的就是最新结构，拆的只是这份迁移自己的东西。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "apps/api/prisma/schema.prisma");
const MIGRATION = path.join(ROOT, "apps/api/prisma/migrations/20260928_cs_chat_and_inquiry_quote/migration.sql");

function prisma(args: string[], url: string): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["prisma", ...args], { cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e: any) {
    return { code: typeof e.status === "number" ? e.status : 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  const u = new URL(url);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname) || process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    // 要新建 / 删除一个临时数据库，只许在本机一次性库（CI 的 services postgres、本地 docker）上做，Neon 和生产绝不碰
    console.log("⚠️ 跳过：这一项要临时建库，只在本机一次性库上跑（CI 的 test-db 那一组会真跑）—— 这一项等于没测");
    return;
  }
  const tmpName = `zz_mig_cschat_${Date.now().toString(36)}`;
  const tmp = new URL(url);
  tmp.pathname = `/${tmpName}`;
  const tmpUrl = tmp.toString();

  const admin = new PrismaClient({ datasources: { db: { url } } });
  let passed = 0, failed = 0;
  const check = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); passed++; console.log(`✅ ${name}`); }
    catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
  };

  await admin.$executeRawUnsafe(`CREATE DATABASE "${tmpName}"`);
  const db = new PrismaClient({ datasources: { db: { url: tmpUrl } } });
  try {
    const push = prisma(["db", "push", `--schema=${SCHEMA}`, "--skip-generate"], tmpUrl);
    assert.equal(push.code, 0, `临时库建结构失败：${push.out.slice(-400)}`);

    // 回到上线前的样子：拆掉这份迁移自己加的东西
    await db.$executeRawUnsafe(`DROP TABLE "cs_messages"`);
    await db.$executeRawUnsafe(`DROP TABLE "cs_conversations"`);
    await db.$executeRawUnsafe(`ALTER TABLE "fcl_inquiries" DROP CONSTRAINT "fcl_inquiries_fcl_container_id_fkey"`);
    for (const col of ["quote_amount_cny", "quote_note", "quoted_at", "quoted_by", "accepted_at", "fcl_container_id", "converted_at", "converted_by"]) {
      await db.$executeRawUnsafe(`ALTER TABLE "fcl_inquiries" DROP COLUMN "${col}"`);
    }
    // 一条老数据：上线前就在的询价单（线上真有 1 条）
    await db.$executeRawUnsafe(`INSERT INTO "users" (id, company_id, role, name, phone, status) VALUES ('ZZMIG1', 'zz_mig_co', 'client', '老客户', '0', 'active')`);
    await db.$executeRawUnsafe(`INSERT INTO "fcl_inquiries" (id, company_id, client_id, created_by, created_by_role, product_name, cargo_value, cargo_weight, address, container_type, service_type, status, created_at, updated_at)
      VALUES ('zz_mig_inq', 'zz_mig_co', 'ZZMIG1', 'ZZMIG1', 'client', '老货', '1万', '5吨', '曼谷', '1*40HQ', '清提派', 'pending', '2026-07-08 01:02:03', '2026-07-08 01:02:03')`);
    const before = await db.$queryRawUnsafe<any[]>(`SELECT * FROM "fcl_inquiries" WHERE id = 'zz_mig_inq'`);

    await check("M1 迁移文件在「上线前的库」上能跑通，而且连跑两遍不报错（可重复执行）", () => {
      for (const n of [1, 2]) {
        const r = prisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION], tmpUrl);
        assert.equal(r.code, 0, `第 ${n} 遍失败：${r.out.slice(-400)}`);
      }
    });

    await check("M2 跑完以后库跟 schema.prisma 一点差异都没有（索引、唯一约束、外键、类型全对上）", () => {
      const r = prisma(["migrate", "diff", "--from-url", tmpUrl, "--to-schema-datamodel", SCHEMA, "--script", "--exit-code"], tmpUrl);
      assert.equal(r.code, 0, `还差这些（迁移漏了 / 写错了）：\n${r.out.split("\n").filter((l) => l.trim() && !l.startsWith("--")).slice(0, 12).join("\n")}`);
    });

    await check("M3 老询价单一个字没变（新列都是空的、状态照旧「待处理」）", async () => {
      // ⚠️ 查询文字要跟迁移前那句不一样：同一句预编译过的查询在改表结构后再用，库会报「cached plan must not change result type」
      const after = await db.$queryRawUnsafe<any[]>(`SELECT *, 'after' AS zz_phase FROM "fcl_inquiries" WHERE id = 'zz_mig_inq'`);
      assert.equal(after.length, 1);
      for (const [k, v] of Object.entries(before[0])) {
        assert.deepEqual(after[0][k], v, `老数据的 ${k} 被改了`);
      }
      for (const col of ["quote_amount_cny", "quote_note", "quoted_at", "quoted_by", "accepted_at", "fcl_container_id", "converted_at", "converted_by"]) {
        assert.equal(after[0][col], null, `新列 ${col} 给老数据填了值`);
      }
    });
  } finally {
    await db.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${tmpName}" WITH (FORCE)`);
    await admin.$disconnect();
  }
  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
