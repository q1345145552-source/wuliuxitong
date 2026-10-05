/**
 * 真跑一遍 20261006_arrival_notices/migration.sql（照 test-migration-cs-chat-push-db.ts 的做法）。
 *
 * 为什么要有：CI 的连库测试是拿 schema.prisma 直接 db push 建库，**完全绕过迁移文件** ——
 * 迁移里列名写错、外键漏了，所有测试照样全绿，上线 deploy.sh 跑迁移才炸。
 * 上线脚本迁移完会跑 scripts/check-schema-drift.sql 体检，这里一并跑一遍。
 *
 * 做法（只在一次性库上跑，要临时建一个数据库）：
 *   1. 新建临时库，按当前 schema.prisma 建好结构；删掉这份迁移加的两张表 = 回到上线前的样子；放一条老运单；
 *   2. 迁移文件连跑两遍（第二遍验证能重复执行）；
 *   3. `prisma migrate diff` 比对库和 schema.prisma：必须一点差异都没有；
 *   4. 上线体检 check-schema-drift.sql：一行都不输出；
 *   5. 老运单一个字没变；删到货通知时照片记录跟着删（外键 ON DELETE CASCADE）；删掉临时库。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "apps/api/prisma/schema.prisma");
const MIGRATION = path.join(ROOT, "apps/api/prisma/migrations/20261006_arrival_notices/migration.sql");
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
  const tmpName = `zz_mig_arrival_${Date.now().toString(36)}`;
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
    // 回到上线前的样子：拆掉这份迁移自己加的两张表
    await db.$executeRawUnsafe(`DROP TABLE "arrival_notice_images"`);
    await db.$executeRawUnsafe(`DROP TABLE "arrival_notices"`);
    // 一条老数据：上线前就在的一张运单
    await db.$executeRawUnsafe(`INSERT INTO "users" (id, company_id, role, name, phone, status) VALUES ('ZZMIGA1', 'zz_miga_co', 'client', '老客户', '0', 'active')`);
    await db.$executeRawUnsafe(`INSERT INTO "orders" (id, company_id, client_id, warehouse_id, item_name, product_quantity, package_count, package_unit, transport_mode, receiver_name_th, receiver_phone_th, receiver_address_th, updated_at)
      VALUES ('zz_miga_o', 'zz_miga_co', 'ZZMIGA1', 'wh_yiwu_01', '老货', 1, 1, 'box', 'sea', '', '', '', '2026-10-01 01:02:03')`);
    await db.$executeRawUnsafe(`INSERT INTO "shipments" (id, company_id, order_id, tracking_no, current_status, warehouse_id, updated_at)
      VALUES ('zz_miga_s', 'zz_miga_co', 'zz_miga_o', 'ZZMIGA-OLD', 'inWarehouseCN', 'wh_yiwu_01', '2026-10-01 01:02:03')`);
    const before = await db.$queryRawUnsafe<any[]>(`SELECT * FROM "shipments" WHERE id = 'zz_miga_s'`);

    await check("M1 迁移文件在「上线前的库」上能跑通，而且连跑两遍不报错（可重复执行）", () => {
      for (const n of [1, 2]) {
        const r = prisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION], tmpUrl);
        assert.equal(r.code, 0, `第 ${n} 遍失败：${r.out.slice(-400)}`);
      }
    });

    await check("M2 跑完以后库跟 schema.prisma 一点差异都没有（列、类型、索引、外键全对上）", () => {
      const r = prisma(["migrate", "diff", "--from-url", tmpUrl, "--to-schema-datamodel", SCHEMA, "--script", "--exit-code"], tmpUrl);
      assert.equal(r.code, 0, `还差这些（迁移漏了 / 写错了）：\n${r.out.split("\n").filter((l) => l.trim() && !l.startsWith("--")).slice(0, 12).join("\n")}`);
    });

    await check("M3 上线体检 check-schema-drift.sql 一行都不输出（清单里有新加的两张表，也没多写）", async () => {
      const rows = await db.$queryRawUnsafe<any[]>(readFileSync(DRIFT, "utf8"));
      assert.equal(rows.length, 0, `体检报了：${JSON.stringify(rows).slice(0, 400)}`);
    });

    await check("M4 老运单一个字没变；删到货通知时照片记录跟着删（外键在）", async () => {
      const after = await db.$queryRawUnsafe<any[]>(`SELECT *, 'after' AS zz_phase FROM "shipments" WHERE id = 'zz_miga_s'`);
      assert.equal(after.length, 1);
      for (const [k, v] of Object.entries(before[0])) assert.deepEqual(after[0][k], v, `老数据的 ${k} 被改了`);
      await db.$executeRawUnsafe(`INSERT INTO "arrival_notices" (id, company_id, created_by, updated_at) VALUES ('zz_miga_n', 'zz_miga_co', 'u', now())`);
      await db.$executeRawUnsafe(`INSERT INTO "arrival_notice_images" (id, company_id, notice_id, file_name, mime, file_path, uploaded_by) VALUES ('zz_miga_i', 'zz_miga_co', 'zz_miga_n', 'a.jpg', 'image/jpeg', '/images/a.jpg', 'u')`);
      await db.$executeRawUnsafe(`DELETE FROM "arrival_notices" WHERE id = 'zz_miga_n'`);
      const left = await db.$queryRawUnsafe<any[]>(`SELECT id FROM "arrival_notice_images" WHERE id = 'zz_miga_i'`);
      assert.equal(left.length, 0, "删了到货通知，照片记录还在（外键没建上）");
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
