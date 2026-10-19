/**
 * 真跑一遍 20261020_user_remark/migration.sql（照 test-migration-arrival-notice-snapshots-db.ts 的做法）。
 *
 * 为什么要有：CI 的连库测试是拿 schema.prisma 直接 db push 建库，**完全绕过迁移文件** ——
 * 迁移里列名、类型写错，所有测试照样全绿，上线后才发现。
 * 上线脚本 deploy.sh 迁移完会跑 scripts/check-schema-drift.sql 体检，清单漏了新字段会报「B 多余」—— 一并跑。
 *
 * 做法（只在一次性库上跑，要临时建一个数据库）：
 *   1. 新建临时库，按当前 schema.prisma 建好结构；拆掉这份迁移加的那一列 = 回到上线前的样子；放几个上线前就有的号；
 *   2. 迁移文件连跑两遍（第二遍验证能重复执行）；
 *   3. `prisma migrate diff` 比对库和 schema.prisma：必须一点差异都没有；
 *   4. 上线体检 check-schema-drift.sql：一行都不输出；
 *   5. 老的号一个字没动、备注都是空的；已经写了的备注再跑一遍不动；删掉临时库。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "apps/api/prisma/schema.prisma");
const MIGRATION = path.join(ROOT, "apps/api/prisma/migrations/20261020_user_remark/migration.sql");
const DRIFT = path.join(ROOT, "scripts/check-schema-drift.sql");

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
  const tmpName = `zz_mig_urmk_${Date.now().toString(36)}`;
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
  const snapshot = async () => db.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT id, company_id, role, name, phone, status, password_hash, agent_id FROM users ORDER BY id`);
  try {
    const push = prisma(["db", "push", `--schema=${SCHEMA}`, "--skip-generate"], tmpUrl);
    assert.equal(push.code, 0, `临时库建结构失败：${push.out.slice(-400)}`);
    // 回到上线前的样子：拆掉这份迁移自己加的那一列；放几个上线前就有的号（老数据，迁移不许动）
    await db.$executeRawUnsafe(`ALTER TABLE "users" DROP COLUMN "remark"`);
    await db.$executeRawUnsafe(`INSERT INTO users (id, company_id, role, name, phone, status, password_hash) VALUES
      ('zz_s1', 'c_zz', 'staff', '员工一', '001', 'active', 'h1'),
      ('zz_s2', 'c_zz', 'staff', '员工二', '002', 'inactive', 'h2'),
      ('ZZC1', 'c_zz', 'client', '客户一', '003', 'active', 'h3'),
      ('zz_a1', 'c_zz', 'admin', '超管', '004', 'active', 'h4')`);
    const before = await snapshot();

    await check("U1 迁移文件在「上线前的库」上能跑通，而且连跑两遍不报错（可重复执行）", () => {
      for (const n of [1, 2]) {
        const r = prisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION], tmpUrl);
        assert.equal(r.code, 0, `第 ${n} 遍失败：${r.out.slice(-400)}`);
      }
    });

    await check("U2 跑完以后库跟 schema.prisma 一点差异都没有（列名、类型、可空全对上）", () => {
      const r = prisma(["migrate", "diff", "--from-url", tmpUrl, "--to-schema-datamodel", SCHEMA, "--script", "--exit-code"], tmpUrl);
      assert.equal(r.code, 0, `还差这些（迁移漏了 / 写错了）：\n${r.out.split("\n").filter((l) => l.trim() && !l.startsWith("--")).slice(0, 12).join("\n")}`);
    });

    await check("U3 上线体检 check-schema-drift.sql 一行都不输出（清单里有 users.remark，也没多写）", async () => {
      const rows = await db.$queryRawUnsafe<any[]>(readFileSync(DRIFT, "utf8"));
      assert.equal(rows.length, 0, `体检报了：${JSON.stringify(rows).slice(0, 400)}`);
    });

    await check("U4 不回填老数据：现有的号一个字没动，备注全是空的", async () => {
      assert.deepEqual(await snapshot(), before, "迁移动了老的号");
      const rows = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM users WHERE remark IS NOT NULL`);
      assert.equal(Number(rows[0].n), 0, "迁移给老的号填了备注");
    });

    await check("U5 跑过一遍以后再跑：已经写了的备注一个字不动", async () => {
      await db.$executeRawUnsafe(`UPDATE users SET remark = '义乌仓管' WHERE id = 'zz_s1'`);
      const r = prisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION], tmpUrl);
      assert.equal(r.code, 0, r.out.slice(-300));
      const rows = await db.$queryRawUnsafe<Array<{ id: string; remark: string | null }>>(`SELECT id, remark FROM users`);
      rows.sort((a, b) => (a.id < b.id ? -1 : 1)); // 别靠库的排序规则（大小写怎么排各库不一样）
      assert.deepEqual(rows, [
        { id: "ZZC1", remark: null }, { id: "zz_a1", remark: null }, { id: "zz_s1", remark: "义乌仓管" }, { id: "zz_s2", remark: null },
      ]);
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
