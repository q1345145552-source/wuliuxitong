/**
 * 真跑一遍 20261011_special_cargo_type/migration.sql（照 test-migration-number-seq-db.ts 的做法）。
 *
 * 为什么要有：CI 的连库测试是拿 schema.prisma 直接 db push 建库，**完全绕过迁移文件** ——
 * 迁移里列类型、默认值写错，所有测试照样全绿，上线后才发现老代理 / 老柜子的特别货价是空的或不是 1250。
 * 另外上线脚本 deploy.sh 迁移完会跑 scripts/check-schema-drift.sql 体检，清单漏了新列会报「B 多余」—— 一并跑。
 *
 * 做法（只在一次性库上跑，要临时建一个数据库）：
 *   1. 新建临时库，按当前 schema.prisma 建好结构；拆掉这份迁移加的 8 列 = 回到上线前的样子；
 *   2. 先插一个「上线前就有的」代理（只有三档价）；
 *   3. 迁移文件连跑两遍（第二遍验证能重复执行）；
 *   4. `prisma migrate diff` 比对库和 schema.prisma：必须一点差异都没有；
 *   5. 上线体检 check-schema-drift.sql：一行都不输出；
 *   6. 老代理的特别货价自动是 1250，三档老价一分没动；删掉临时库。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "apps/api/prisma/schema.prisma");
const MIGRATION = path.join(ROOT, "apps/api/prisma/migrations/20261011_special_cargo_type/migration.sql");
const DRIFT = path.join(ROOT, "scripts/check-schema-drift.sql");

/** 这份迁移加的 8 列：[表, 列, 期望类型, 期望可空, 期望默认值] */
const NEW_COLUMNS: Array<[string, string, string, "YES" | "NO", string | null]> = [
  ["whr_consolidation_plan_customers", "unit_price_special", "numeric(10,2)", "NO", "1250"],
  ["whr_consolidation_prealerts", "paid_price_special", "numeric(10,2)", "YES", null],
  ["whr_consolidation_prealerts", "paid_agent_price_special", "numeric(10,2)", "YES", null],
  ["agents", "price_special", "numeric(10,2)", "NO", "1250"],
  ["client_whr_prices", "price_special", "numeric(10,2)", "NO", "1250"],
  ["agent_rebate_lines", "volume_special_m3", "numeric(12,3)", "NO", "0"],
  ["agent_rebate_lines", "client_price_special", "numeric(10,2)", "NO", "0"],
  ["agent_rebate_lines", "agent_price_special", "numeric(10,2)", "NO", "0"],
];

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
  const tmpName = `zz_mig_special_${Date.now().toString(36)}`;
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
    // 回到上线前的样子：拆掉这份迁移自己加的 8 列
    for (const [table, column] of NEW_COLUMNS) {
      await db.$executeRawUnsafe(`ALTER TABLE "${table}" DROP COLUMN "${column}"`);
    }
    // 上线前就有的代理：只有三档价
    await db.$executeRawUnsafe(
      `INSERT INTO agents (id, company_id, name, price_normal, price_inspection, price_sensitive, updated_at)
       VALUES ('zz_old_agent', 'c_zz', '老代理', 500, 600, 700, now())`,
    );

    await check("S1 迁移文件在「上线前的库」上能跑通，而且连跑两遍不报错（可重复执行）", () => {
      for (const n of [1, 2]) {
        const r = prisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION], tmpUrl);
        assert.equal(r.code, 0, `第 ${n} 遍失败：${r.out.slice(-400)}`);
      }
    });

    await check("S2 跑完以后库跟 schema.prisma 一点差异都没有（类型、默认值、可空全对上）", () => {
      const r = prisma(["migrate", "diff", "--from-url", tmpUrl, "--to-schema-datamodel", SCHEMA, "--script", "--exit-code"], tmpUrl);
      assert.equal(r.code, 0, `还差这些（迁移漏了 / 写错了）：\n${r.out.split("\n").filter((l) => l.trim() && !l.startsWith("--")).slice(0, 12).join("\n")}`);
    });

    await check("S3 上线体检 check-schema-drift.sql 一行都不输出（清单里有这 8 列，也没多写）", async () => {
      const rows = await db.$queryRawUnsafe<any[]>(readFileSync(DRIFT, "utf8"));
      assert.equal(rows.length, 0, `体检报了：${JSON.stringify(rows).slice(0, 400)}`);
    });

    await check("S4 8 列的类型 / 可空 / 默认值逐列核：特别货价默认 1250，付款快照可空，返现明细默认 0", async () => {
      for (const [table, column, type, nullable, def] of NEW_COLUMNS) {
        const rows = await db.$queryRawUnsafe<Array<{ type: string; is_nullable: string; column_default: string | null }>>(
          `SELECT format_type(a.atttypid, a.atttypmod) AS type, c.is_nullable, c.column_default
             FROM information_schema.columns c
             JOIN pg_attribute a ON a.attrelid = c.table_name::regclass AND a.attname = c.column_name
            WHERE c.table_name = $1 AND c.column_name = $2`,
          table,
          column,
        );
        assert.equal(rows.length, 1, `${table}.${column} 没建出来`);
        assert.equal(rows[0].type, type, `${table}.${column} 类型`);
        assert.equal(rows[0].is_nullable, nullable, `${table}.${column} 可空`);
        const gotDefault = rows[0].column_default == null ? null : String(rows[0].column_default).replace(/::numeric$/, "");
        assert.equal(gotDefault, def, `${table}.${column} 默认值`);
      }
    });

    await check("S5 上线前就有的代理：特别货价自动是 1250，三档老价一分没动", async () => {
      const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT price_normal::text AS n, price_inspection::text AS i, price_sensitive::text AS s, price_special::text AS sp FROM agents WHERE id = 'zz_old_agent'`,
      );
      assert.deepEqual(rows[0], { n: "500.00", i: "600.00", s: "700.00", sp: "1250.00" });
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
