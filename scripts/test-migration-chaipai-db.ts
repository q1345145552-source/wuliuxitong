/**
 * 真跑一遍 20261012_chaipai_integration/migration.sql（照 test-migration-special-cargo-type-db.ts 的做法）。
 *
 * 为什么要有：CI 的连库测试是拿 schema.prisma 直接 db push 建库，**完全绕过迁移文件** ——
 * 迁移里列类型、默认值、外键写错，所有测试照样全绿，上线后才发现。
 * 上线脚本 deploy.sh 迁移完会跑 scripts/check-schema-drift.sql 体检，清单漏了新表会报「B 多余」—— 一并跑。
 *
 * 做法（只在一次性库上跑，要临时建一个数据库）：
 *   1. 新建临时库，按当前 schema.prisma 建好结构；拆掉这份迁移加的 3 张表 = 回到上线前的样子；
 *   2. 迁移文件连跑两遍（第二遍验证能重复执行）；
 *   3. `prisma migrate diff` 比对库和 schema.prisma：必须一点差异都没有；
 *   4. 上线体检 check-schema-drift.sql：一行都不输出；
 *   5. 删运单时「每票最后状态」跟着删（外键 CASCADE，不挡删订单 / 删运单的老流程），消息记录和清单版本不受影响；删掉临时库。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "apps/api/prisma/schema.prisma");
const MIGRATION = path.join(ROOT, "apps/api/prisma/migrations/20261012_chaipai_integration/migration.sql");
const DRIFT = path.join(ROOT, "scripts/check-schema-drift.sql");
const NEW_TABLES = ["chaipai_callback_events", "chaipai_shipment_states", "chaipai_manifest_versions"];

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
  const tmpName = `zz_mig_chaipai_${Date.now().toString(36)}`;
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
    // 回到上线前的样子：拆掉这份迁移自己加的 3 张表
    for (const table of NEW_TABLES) await db.$executeRawUnsafe(`DROP TABLE "${table}"`);

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

    await check("M3 上线体检 check-schema-drift.sql 一行都不输出（清单里有这 3 张表 32 个字段，也没多写）", async () => {
      const rows = await db.$queryRawUnsafe<any[]>(readFileSync(DRIFT, "utf8"));
      assert.equal(rows.length, 0, `体检报了：${JSON.stringify(rows).slice(0, 400)}`);
    });

    await check("M5 只跑过早一版迁移的库（少 handover_tracking_no 等列、公司编号必填）：再跑一遍就补齐，跟 schema 零差异", async () => {
      await db.$executeRawUnsafe(`ALTER TABLE "chaipai_shipment_states" DROP COLUMN "handover_tracking_no", DROP COLUMN "released_routes"`);
      await db.$executeRawUnsafe(`ALTER TABLE "chaipai_callback_events" ALTER COLUMN "company_id" SET NOT NULL`);
      const r = prisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION], tmpUrl);
      assert.equal(r.code, 0, `升级失败：${r.out.slice(-400)}`);
      const d = prisma(["migrate", "diff", "--from-url", tmpUrl, "--to-schema-datamodel", SCHEMA, "--script", "--exit-code"], tmpUrl);
      assert.equal(d.code, 0, `还差：\n${d.out.split("\n").filter((l) => l.trim() && !l.startsWith("--")).slice(0, 8).join("\n")}`);
    });

    await check("M6 跑过更早一稿的库（撤单号是两列 released_route_id / released_delivery_no）：再跑一遍并进 released_routes、旧两列删掉、零差异", async () => {
      await db.$executeRawUnsafe(`INSERT INTO users (id, company_id, role, name, phone, status) VALUES ('ZZC6', 'c_zz', 'client', '测试客户6', '000', 'active')`);
      await db.$executeRawUnsafe(`INSERT INTO orders (id, company_id, client_id, warehouse_id, item_name, product_quantity, package_count, package_unit,
          receiver_name_th, receiver_phone_th, receiver_address_th, transport_mode, updated_at)
        VALUES ('zz_o6', 'c_zz', 'ZZC6', 'wh', '鞋', 1, 1, '箱', '收货人', '000', '地址', 'sea', now())`);
      await db.$executeRawUnsafe(`INSERT INTO shipments (id, company_id, order_id, tracking_no, current_status, warehouse_id, updated_at)
        VALUES ('zz_s6', 'c_zz', 'zz_o6', 'ZZT6', 'inWarehouseTH', 'wh', now())`);
      await db.$executeRawUnsafe(`ALTER TABLE "chaipai_shipment_states" DROP COLUMN "released_routes", ADD COLUMN "released_route_id" TEXT, ADD COLUMN "released_delivery_no" TEXT`);
      await db.$executeRawUnsafe(`INSERT INTO chaipai_shipment_states (shipment_id, company_id, last_sequence, last_event_id, thai_status, occurred_at, updated_at, released_route_id, released_delivery_no)
        VALUES ('zz_s6', 'c_zz', 3, 'e6', 'ARRIVED', now(), now(), 'route-R', 'WD000101')`);
      const r = prisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION], tmpUrl);
      assert.equal(r.code, 0, `升级失败：${r.out.slice(-400)}`);
      const rows = await db.$queryRawUnsafe<Array<{ r: unknown }>>(`SELECT released_routes AS r FROM chaipai_shipment_states WHERE shipment_id = 'zz_s6'`);
      assert.deepEqual(rows[0].r, { "route-R": "WD000101" }, "旧的撤单号没并进来");
      const d = prisma(["migrate", "diff", "--from-url", tmpUrl, "--to-schema-datamodel", SCHEMA, "--script", "--exit-code"], tmpUrl);
      assert.equal(d.code, 0, `还差：\n${d.out.split("\n").filter((l) => l.trim() && !l.startsWith("--")).slice(0, 8).join("\n")}`);
      const drift = await db.$queryRawUnsafe<any[]>(readFileSync(DRIFT, "utf8"));
      assert.equal(drift.length, 0, `体检报了：${JSON.stringify(drift).slice(0, 300)}`);
      await db.$executeRawUnsafe(`DELETE FROM shipments WHERE id = 'zz_s6'`);
    });

    await check("M4 删运单：每票最后状态跟着删（不挡老流程）；消息记录、清单版本没有外键，照样留着", async () => {
      await db.$executeRawUnsafe(`INSERT INTO users (id, company_id, role, name, phone, status) VALUES ('ZZC', 'c_zz', 'client', '测试客户', '000', 'active')`);
      await db.$executeRawUnsafe(`INSERT INTO orders (id, company_id, client_id, warehouse_id, item_name, product_quantity, package_count, package_unit,
          receiver_name_th, receiver_phone_th, receiver_address_th, transport_mode, updated_at)
        VALUES ('zz_o1', 'c_zz', 'ZZC', 'wh', '鞋', 1, 1, '箱', '收货人', '000', '地址', 'sea', now())`);
      await db.$executeRawUnsafe(`INSERT INTO shipments (id, company_id, order_id, tracking_no, current_status, warehouse_id, updated_at)
        VALUES ('zz_s1', 'c_zz', 'zz_o1', 'ZZT1', 'inWarehouseTH', 'wh', now())`);
      await db.$executeRawUnsafe(`INSERT INTO chaipai_shipment_states (shipment_id, company_id, last_sequence, last_event_id, thai_status, occurred_at, updated_at)
        VALUES ('zz_s1', 'c_zz', 1, 'e1', 'ARRIVED', now(), now())`);
      await db.$executeRawUnsafe(`INSERT INTO chaipai_callback_events (event_id, company_id, source_company_id, shipment_id, sequence, status, occurred_at, payload_hash, payload, result)
        VALUES ('e1', 'c_zz', 'xiangtai', 'zz_s1', 1, 'ARRIVED', now(), 'h', '{}'::jsonb, 'APPLIED')`);
      await db.$executeRawUnsafe(`INSERT INTO chaipai_manifest_versions (shipment_id, company_id, content_hash, version_at)
        VALUES ('zz_s1', 'c_zz', 'h', now())`);
      await db.$executeRawUnsafe(`DELETE FROM shipments WHERE id = 'zz_s1'`);
      const count = async (t: string) => Number((await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM ${t}`))[0].n);
      assert.equal(await count("chaipai_shipment_states"), 0, "每票最后状态没跟着删");
      assert.equal(await count("chaipai_callback_events"), 1, "消息记录不该被删");
      assert.equal(await count("chaipai_manifest_versions"), 1, "清单版本不该被删");
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
