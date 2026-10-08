/**
 * 真跑一遍 20261006_arrival_notices/migration.sql（照 test-migration-cs-chat-push-db.ts 的做法）。
 *
 * 为什么要有：CI 的连库测试是拿 schema.prisma 直接 db push 建库，**完全绕过迁移文件** ——
 * 迁移里列名写错、外键漏了，所有测试照样全绿，上线 deploy.sh 跑迁移才炸。
 * 上线脚本迁移完会跑 scripts/check-schema-drift.sql 体检，这里一并跑一遍。
 *
 * 做法（只在一次性库上跑，要临时建一个数据库）：
 *   1. 新建临时库，按当前 schema.prisma 建好结构；删掉这份迁移加的两张表 = 回到上线前的样子；放一条老运单；
 *   2. 迁移文件连跑两遍（第二遍验证能重复执行）；再跑 20261008 那份（加货型、照片小图两列 + 末尾回填改过号的老记录），也连跑两遍；
 *   3. `prisma migrate diff` 比对库和 schema.prisma：必须一点差异都没有；
 *   4. 上线体检 check-schema-drift.sql：一行都不输出；
 *   5. 老运单一个字没变；删到货通知时照片记录跟着删（外键 ON DELETE CASCADE）；删掉临时库。
 *   （修复第 3 轮）回填跳过的那几条，部署后的只读体检 check-arrival-notice-tracking-no.sql 要正好列出来。
 *   （修复第 4 轮）末尾再回填唛头：订单被改给别的客户的老到货通知跟上订单现在的客户、清掉「已通知」（M1d）。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "apps/api/prisma/schema.prisma");
const MIGRATION = path.join(ROOT, "apps/api/prisma/migrations/20261006_arrival_notices/migration.sql");
/** 2026-10-08 第四轮审查加的两列（货型、照片小图）：上线顺序是先 20261006 再它，这里也照这个顺序跑 */
const MIGRATION_1008 = path.join(ROOT, "apps/api/prisma/migrations/20261008_arrival_notice_fixes/migration.sql");
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

    await check("M1b 10-08 那份（加货型、照片小图两列）在「已经上了 10-06」的库上能跑通、连跑两遍不报错；已有的到货通知一个字不变", async () => {
      await db.$executeRawUnsafe(`INSERT INTO "arrival_notices" (id, company_id, created_by, updated_at, tracking_no) VALUES ('zz_miga_n0', 'zz_miga_co', 'u', '2026-10-07 01:02:03', 'ZZMIGA-N0')`);
      const noticeBefore = await db.$queryRawUnsafe<any[]>(`SELECT * FROM "arrival_notices" WHERE id = 'zz_miga_n0'`);
      assert.equal(noticeBefore.length, 1);
      assert.ok(!("cargo_type" in noticeBefore[0]), "跑 10-08 之前库里就有货型列了：这一项没测到「从 10-06 升上来」");
      for (const n of [1, 2]) {
        const r = prisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION_1008], tmpUrl);
        assert.equal(r.code, 0, `第 ${n} 遍失败：${r.out.slice(-400)}`);
      }
      // 换一句查询文字：同一句 SELECT * 在加列前后复用会撞 PostgreSQL「cached plan must not change result type」（同 M4 的写法）
      const noticeAfter = await db.$queryRawUnsafe<any[]>(`SELECT *, 'after' AS zz_phase FROM "arrival_notices" WHERE id = 'zz_miga_n0'`);
      for (const [k, v] of Object.entries(noticeBefore[0])) assert.deepEqual(noticeAfter[0][k], v, `老到货通知的 ${k} 被改了`);
      assert.equal(noticeAfter[0].cargo_type, null, "老记录货型是空（= 普货）");
      await db.$executeRawUnsafe(`DELETE FROM "arrival_notices" WHERE id = 'zz_miga_n0'`);
    });

    await check("M1c 10-08 那份末尾的回填（修复第 1 轮 F06）：转了正式又在运单管理改过号的，改成运单现在的号；号被别条占着 / 一张运单挂两条 / 运单删了 / 没转的都不动；连环改号**跑一遍**就改完（修复第 2 轮）、互换号不死循环；连跑两遍第二遍不改", async () => {
      const ins = (sql: string) => db.$executeRawUnsafe(sql);
      await ins(`INSERT INTO "shipments" (id, company_id, order_id, tracking_no, current_status, warehouse_id, updated_at) VALUES
        ('zz_miga_s2', 'zz_miga_co', 'zz_miga_o', 'ZZMIGA-HELD', 'inWarehouseCN', 'wh_yiwu_01', now()),
        ('zz_miga_s3', 'zz_miga_co', 'zz_miga_o', 'ZZMIGA-DUP', 'inWarehouseCN', 'wh_yiwu_01', now()),
        ('zz_miga_s4', 'zz_miga_co', 'zz_miga_o', 'ZZMIGA-NEW', 'inWarehouseCN', 'wh_yiwu_01', now()),
        ('zz_miga_s7', 'zz_miga_co', 'zz_miga_o', 'ZZMIGA-P8', 'inWarehouseCN', 'wh_yiwu_01', now()),
        ('zz_miga_s8', 'zz_miga_co', 'zz_miga_o', 'ZZMIGA-P8NEW', 'inWarehouseCN', 'wh_yiwu_01', now()),
        ('zz_miga_s11', 'zz_miga_co', 'zz_miga_o', 'ZZMIGA-QA', 'inWarehouseCN', 'wh_yiwu_01', now()),
        ('zz_miga_s12', 'zz_miga_co', 'zz_miga_o', 'ZZMIGA-QB', 'inWarehouseCN', 'wh_yiwu_01', now())`);
      await ins(`INSERT INTO "arrival_notices" (id, company_id, created_by, updated_at, tracking_no, converted_to, shipment_id) VALUES
        ('zz_miga_b1', 'zz_miga_co', 'u', now(), 'ZZMIGA-STALE', 'formal', 'zz_miga_s4'),
        ('zz_miga_b2', 'zz_miga_co', 'u', now(), 'ZZMIGA-B2OLD', 'formal', 'zz_miga_s2'),
        ('zz_miga_b3', 'zz_miga_co', 'u', now(), 'ZZMIGA-HELD', NULL, NULL),
        ('zz_miga_b4', 'zz_miga_co', 'u', now(), 'ZZMIGA-D1', 'formal', 'zz_miga_s3'),
        ('zz_miga_b5', 'zz_miga_co', 'u', now(), 'ZZMIGA-D2', 'formal', 'zz_miga_s3'),
        ('zz_miga_b6', 'zz_miga_co', 'u', now(), 'ZZMIGA-GONE', 'formal', 'zz_miga_deleted'),
        ('zz_miga_b7', 'zz_miga_co', 'u', now(), 'ZZMIGA-OK', 'formal', 'zz_miga_s'),
        ('zz_miga_b8', 'zz_miga_co', 'u', now(), 'ZZMIGA-RAW', NULL, 'zz_miga_s4x'),
        ('zz_miga_b9', 'zz_miga_co', 'u', now(), 'ZZMIGA-P7', 'formal', 'zz_miga_s7'),
        ('zz_miga_b10', 'zz_miga_co', 'u', now(), 'ZZMIGA-P8', 'formal', 'zz_miga_s8'),
        ('zz_miga_b11', 'zz_miga_co', 'u', now(), 'ZZMIGA-QB', 'formal', 'zz_miga_s11'),
        ('zz_miga_b12', 'zz_miga_co', 'u', now(), 'ZZMIGA-QA', 'formal', 'zz_miga_s12')`);
      // zz_miga_b7 号对不上、运单是 zz_miga_s（ZZMIGA-OLD）：也该回填
      // b9 / b10 连环改号：运单 s8 从 P8 改成 P8NEW、运单 s7 又从 P7 改成 P8（b10 还占着 P8）。b11 / b12：两张运单互换了号
      const expected = {
        zz_miga_b1: "ZZMIGA-NEW",   // 改过号：跟上运单现在的号
        zz_miga_b2: "ZZMIGA-B2OLD", // 新号被 b3（没转的）登记着：不动，留给员工
        zz_miga_b3: "ZZMIGA-HELD",
        zz_miga_b4: "ZZMIGA-D1",    // 一张运单挂两条：不动（两行改成同一个号会让整份迁移失败）
        zz_miga_b5: "ZZMIGA-D2",
        zz_miga_b6: "ZZMIGA-GONE",  // 运单删了：不动
        zz_miga_b7: "ZZMIGA-OLD",
        zz_miga_b8: "ZZMIGA-RAW",   // 没转的：不动
        zz_miga_b9: "ZZMIGA-P8",    // 连环改号：b10 先腾出 P8，b9 接着改上 —— 上线只跑一遍，第一遍就得改完
        zz_miga_b10: "ZZMIGA-P8NEW",
        zz_miga_b11: "ZZMIGA-QB",   // 互换号：谁都腾不出来，不动（也不能死循环）
        zz_miga_b12: "ZZMIGA-QA",
      };
      const snapshot = async () => Object.fromEntries((await db.$queryRawUnsafe<any[]>(`SELECT id, tracking_no FROM "arrival_notices" WHERE id LIKE 'zz_miga_b%' ORDER BY id`)).map((r) => [r.id, r.tracking_no]));
      for (const n of [1, 2]) {
        const r = prisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION_1008], tmpUrl);
        assert.equal(r.code, 0, `第 ${n} 遍失败：${r.out.slice(-400)}`);
        assert.deepEqual(await snapshot(), expected, `第 ${n} 遍跑完不对`);
      }
      /* 修复第 3 轮：回填按设计跳过的那几条，migrate deploy 一个字都不说。部署完手工跑 check-arrival-notice-tracking-no.sql（不进 deploy.sh）
         把它们列出来交给员工 —— 这份只读体检必须正好列出跳过的那几条（b2 号被没转的 b3 占着、b11/b12 互换号、b4/b5 一张运单挂两条），
         运单删了的 b6、没转的 b8、已经回填好的都不列 */
      const leftover = await db.$queryRawUnsafe<any[]>(readFileSync(path.join(ROOT, "scripts/check-arrival-notice-tracking-no.sql"), "utf8"));
      const mine = leftover.filter((r) => String(r.notice_id).startsWith("zz_miga_b"));
      assert.deepEqual(mine.map((r) => r.notice_id).sort(), ["zz_miga_b11", "zz_miga_b12", "zz_miga_b2", "zz_miga_b4", "zz_miga_b5"], `体检列出来的不对：${JSON.stringify(mine)}`);
      const b2 = mine.find((r) => r.notice_id === "zz_miga_b2");
      assert.equal(b2.holder_notice_id, "zz_miga_b3", "要点名是哪条占着");
      assert.equal(b2.holder_converted_to, null, "占着的那条没转（员工能在到货通知里改 / 删）");
      assert.equal(b2.shipment_tracking_no, "ZZMIGA-HELD");
      assert.equal(mine.find((r) => r.notice_id === "zz_miga_b11").holder_notice_id, "zz_miga_b12", "互换号：点名另一条");
      assert.ok(!/\b(UPDATE|DELETE|INSERT|ALTER|DROP|TRUNCATE)\b/i.test(readFileSync(path.join(ROOT, "scripts/check-arrival-notice-tracking-no.sql"), "utf8").replace(/--.*$/gm, "")), "体检必须纯只读");
      // 部署脚本不为这次一次性体检改动（2026-10-08 主控决定）：deploy.sh 里不许出现它，SQL 文件开头写清部署后手工跑
      assert.ok(!/check-arrival-notice-tracking-no/.test(readFileSync(path.join(ROOT, "deploy.sh"), "utf8")), "deploy.sh 不跑这份体检（一次性的，部署后手工跑）");
      // 第二遍是空跑：直接再执行一次回填里那一句 UPDATE，改 0 行
      const sql = readFileSync(MIGRATION_1008, "utf8");
      const from = sql.indexOf('UPDATE "arrival_notices" n');
      assert.ok(from > 0, "迁移里找不到回填那一句");
      const update = sql.slice(from, sql.indexOf(";", from));
      assert.equal(await db.$executeRawUnsafe(update), 0, "回填不是幂等的");
      await db.$executeRawUnsafe(`DELETE FROM "arrival_notices" WHERE id LIKE 'zz_miga_b%'`);
      await db.$executeRawUnsafe(`DELETE FROM "shipments" WHERE id IN ('zz_miga_s2', 'zz_miga_s3', 'zz_miga_s4', 'zz_miga_s7', 'zz_miga_s8', 'zz_miga_s11', 'zz_miga_s12')`);
    });

    await check("M1d 修复第 4 轮 10-08 那份末尾补回填唛头：转了运单、又在运单管理把订单改给别的客户的老到货通知，唛头改成订单现在的客户、「已通知」清掉；唛头对得上的 / 没转的 / 运单删了的一个字不动；连跑两遍第二遍不改", async () => {
      const ins = (sql: string) => db.$executeRawUnsafe(sql);
      await ins(`INSERT INTO "users" (id, company_id, role, name, phone, status) VALUES ('ZZMIGA2', 'zz_miga_co', 'client', '新客户', '1', 'active')`);
      await ins(`INSERT INTO "orders" (id, company_id, client_id, warehouse_id, item_name, product_quantity, package_count, package_unit, transport_mode, receiver_name_th, receiver_phone_th, receiver_address_th, updated_at)
        VALUES ('zz_miga_o40', 'zz_miga_co', 'ZZMIGA2', 'wh_yiwu_01', '改了客户', 1, 1, 'box', 'sea', '', '', '', now())`);
      await ins(`INSERT INTO "shipments" (id, company_id, order_id, tracking_no, current_status, warehouse_id, updated_at) VALUES
        ('zz_miga_s40', 'zz_miga_co', 'zz_miga_o40', 'ZZMIGA-C40', 'inWarehouseCN', 'wh_yiwu_01', now()),
        ('zz_miga_s41', 'zz_miga_co', 'zz_miga_o', 'ZZMIGA-C41', 'inWarehouseCN', 'wh_yiwu_01', now())`);
      // c40：订单改给了 ZZMIGA2，到货通知还是 ZZMIGA1、还挂着「已通知」—— 要改；c41：唛头对得上 —— 不动；
      // c42：没转（唛头随便填）—— 不动；c43：转出的运单删了 —— 不动
      await ins(`INSERT INTO "arrival_notices" (id, company_id, client_id, created_by, updated_at, tracking_no, converted_to, shipment_id, notified_at, notified_by, notified_by_name) VALUES
        ('zz_miga_c40', 'zz_miga_co', 'ZZMIGA1', 'u', '2026-10-07 01:02:03', 'ZZMIGA-C40', 'formal', 'zz_miga_s40', '2026-10-07 01:02:03', 'u', '员工'),
        ('zz_miga_c41', 'zz_miga_co', 'ZZMIGA1', 'u', '2026-10-07 01:02:03', 'ZZMIGA-C41', 'formal', 'zz_miga_s41', '2026-10-07 01:02:03', 'u', '员工'),
        ('zz_miga_c42', 'zz_miga_co', 'ZZMIGA2', 'u', '2026-10-07 01:02:03', 'ZZMIGA-C42', NULL, NULL, '2026-10-07 01:02:03', 'u', '员工'),
        ('zz_miga_c43', 'zz_miga_co', 'ZZMIGA1', 'u', '2026-10-07 01:02:03', 'ZZMIGA-C43', 'formal', 'zz_miga_gone40', '2026-10-07 01:02:03', 'u', '员工')`);
      const snap = async () => Object.fromEntries((await db.$queryRawUnsafe<any[]>(`SELECT id, client_id, notified_at, notified_by, notified_by_name, updated_at FROM "arrival_notices" WHERE id LIKE 'zz_miga_c4%' ORDER BY id`)).map((r) => [r.id, r]));
      const before = await snap();
      for (const n of [1, 2]) {
        const r = prisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION_1008], tmpUrl);
        assert.equal(r.code, 0, `第 ${n} 遍失败：${r.out.slice(-400)}`);
        const after = await snap();
        assert.equal(after.zz_miga_c40.client_id, "ZZMIGA2", `第 ${n} 遍：唛头要改成订单现在的客户（原来迁移不管唛头）`);
        assert.equal(after.zz_miga_c40.notified_at, null, "通知的是旧客户：改回未通知");
        assert.equal(after.zz_miga_c40.notified_by, null);
        assert.equal(after.zz_miga_c40.notified_by_name, null);
        // 不带时区的 timestamp(3)，Prisma 按 UTC 读：写成 NOW() AT TIME ZONE 'UTC' 才跟现在对得上
        assert.ok(Math.abs(new Date(after.zz_miga_c40.updated_at).getTime() - Date.now()) < 120_000, `updated_at 写歪了（时区？）：${after.zz_miga_c40.updated_at}`);
        for (const id of ["zz_miga_c41", "zz_miga_c42", "zz_miga_c43"]) assert.deepEqual(after[id], before[id], `第 ${n} 遍：${id} 不该动`);
      }
      const sql = readFileSync(MIGRATION_1008, "utf8");
      const from = sql.indexOf('UPDATE "arrival_notices" AS n');
      assert.ok(from > 0, "迁移里找不到回填唛头那一句");
      assert.equal(await db.$executeRawUnsafe(sql.slice(from, sql.indexOf(";", from))), 0, "回填唛头不是幂等的");
      // 体检不进 deploy.sh：SQL 文件开头要写清「带 20261008 迁移的那次部署跑完以后手工跑」
      assert.match(readFileSync(path.join(ROOT, "scripts/check-arrival-notice-tracking-no.sql"), "utf8"), /带 20261008 迁移的那次部署跑完以后，在服务器上\*\*手工跑一遍\*\*/);
      await ins(`DELETE FROM "arrival_notices" WHERE id LIKE 'zz_miga_c4%'`);
      await ins(`DELETE FROM "shipments" WHERE id IN ('zz_miga_s40', 'zz_miga_s41')`);
      await ins(`DELETE FROM "orders" WHERE id = 'zz_miga_o40'`);
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
