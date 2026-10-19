/**
 * 真跑一遍 20261019_arrival_notice_snapshots/migration.sql（照 test-migration-chaipai-db.ts 的做法）。
 *
 * 为什么要有：CI 的连库测试是拿 schema.prisma 直接 db push 建库，**完全绕过迁移文件** ——
 * 迁移里列类型、默认值、外键写错，所有测试照样全绿，上线后才发现。
 * 上线脚本 deploy.sh 迁移完会跑 scripts/check-schema-drift.sql 体检，清单漏了新表会报「B 多余」—— 一并跑。
 *
 * 做法（只在一次性库上跑，要临时建一个数据库）：
 *   1. 新建临时库，按当前 schema.prisma 建好结构；拆掉这份迁移加的那张表 = 回到上线前的样子；
 *   2. 迁移文件连跑两遍（第二遍验证能重复执行）；
 *   3. `prisma migrate diff` 比对库和 schema.prisma：必须一点差异都没有；
 *   4. 上线体检 check-schema-drift.sql：一行都不输出；
 *   5. 删到货通知原样跟着删（外键 CASCADE），删运单不动原样（没有外键）；老数据一行都没动；删掉临时库。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "apps/api/prisma/schema.prisma");
const MIGRATION = path.join(ROOT, "apps/api/prisma/migrations/20261019_arrival_notice_snapshots/migration.sql");
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
  const tmpName = `zz_mig_ansnap_${Date.now().toString(36)}`;
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
    // 回到上线前的样子：拆掉这份迁移自己加的那张表；放一条上线前就有的到货通知 + 运单（老数据，迁移不许动）
    await db.$executeRawUnsafe(`DROP TABLE "arrival_notice_snapshots"`);
    await db.$executeRawUnsafe(`INSERT INTO users (id, company_id, role, name, phone, status) VALUES ('ZZC', 'c_zz', 'client', '测试客户', '000', 'active')`);
    await db.$executeRawUnsafe(`INSERT INTO orders (id, company_id, client_id, warehouse_id, item_name, product_quantity, package_count, package_unit,
        receiver_name_th, receiver_phone_th, receiver_address_th, transport_mode, updated_at)
      VALUES ('zz_o1', 'c_zz', 'ZZC', 'wh_yiwu_01', '鞋', 1, 1, 'box', '收货人', '000', '地址', 'sea', now())`);
    await db.$executeRawUnsafe(`INSERT INTO shipments (id, company_id, order_id, tracking_no, current_status, warehouse_id, updated_at)
      VALUES ('zz_s1', 'c_zz', 'zz_o1', 'ZZT1', 'inWarehouseCN', 'wh_yiwu_01', now())`);
    await db.$executeRawUnsafe(`INSERT INTO arrival_notices (id, company_id, client_id, tracking_no, converted_to, shipment_id, converted_at, created_by, updated_at)
      VALUES ('zz_n1', 'c_zz', 'ZZC', 'ZZT1', 'formal', 'zz_s1', now(), 'staff', now())`);

    await check("M1 迁移文件在「上线前的库」上能跑通，而且连跑两遍不报错（可重复执行）", () => {
      for (const n of [1, 2]) {
        const r = prisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION], tmpUrl);
        assert.equal(r.code, 0, `第 ${n} 遍失败：${r.out.slice(-400)}`);
      }
    });

    await check("M2 跑完以后库跟 schema.prisma 一点差异都没有（列、类型、默认值、索引、外键全对上）", () => {
      const r = prisma(["migrate", "diff", "--from-url", tmpUrl, "--to-schema-datamodel", SCHEMA, "--script", "--exit-code"], tmpUrl);
      assert.equal(r.code, 0, `还差这些（迁移漏了 / 写错了）：\n${r.out.split("\n").filter((l) => l.trim() && !l.startsWith("--")).slice(0, 12).join("\n")}`);
    });

    await check("M3 上线体检 check-schema-drift.sql 一行都不输出（清单里有这张表 8 个字段，也没多写）", async () => {
      const rows = await db.$queryRawUnsafe<any[]>(readFileSync(DRIFT, "utf8"));
      assert.equal(rows.length, 0, `体检报了：${JSON.stringify(rows).slice(0, 400)}`);
    });

    await check("M4 不回填老数据：上线前转过的那条没有原样（页面写「上线前转的，没存原样」），到货通知和运单一个字没动", async () => {
      const n = Number((await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM arrival_notice_snapshots`))[0].n);
      assert.equal(n, 0);
      const rows = await db.$queryRawUnsafe<Array<{ converted_to: string; shipment_id: string }>>(`SELECT converted_to, shipment_id FROM arrival_notices WHERE id = 'zz_n1'`);
      assert.deepEqual(rows, [{ converted_to: "formal", shipment_id: "zz_s1" }]);
    });

    await check("M5 删运单不动原样（没有外键，运单删了原样照样留着）；删到货通知原样跟着删（外键 CASCADE）", async () => {
      await db.$executeRawUnsafe(`INSERT INTO arrival_notice_snapshots (id, company_id, notice_id, shipment_id, data, converted_by_id)
        VALUES ('zz_snap1', 'c_zz', 'zz_n1', 'zz_s1', '{"v":1}', 'staff')`);
      await db.$executeRawUnsafe(`DELETE FROM shipments WHERE id = 'zz_s1'`);
      const count = async () => Number((await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM arrival_notice_snapshots`))[0].n);
      assert.equal(await count(), 1, "删运单把原样带走了");
      await db.$executeRawUnsafe(`DELETE FROM arrival_notices WHERE id = 'zz_n1'`);
      assert.equal(await count(), 0, "删到货通知原样没跟着删");
    });

    await check("M6 跑过一遍以后再跑：已有的原样一行都不动", async () => {
      await db.$executeRawUnsafe(`INSERT INTO arrival_notices (id, company_id, created_by, updated_at) VALUES ('zz_n2', 'c_zz', 'staff', now())`);
      await db.$executeRawUnsafe(`INSERT INTO arrival_notice_snapshots (id, company_id, notice_id, data, converted_by_id) VALUES ('zz_snap2', 'c_zz', 'zz_n2', '{"v":1,"remark":"原样"}', 'staff')`);
      const r = prisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION], tmpUrl);
      assert.equal(r.code, 0, r.out.slice(-300));
      const rows = await db.$queryRawUnsafe<Array<{ data: string }>>(`SELECT data FROM arrival_notice_snapshots WHERE id = 'zz_snap2'`);
      assert.deepEqual(rows, [{ data: '{"v":1,"remark":"原样"}' }]);
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
