/**
 * 真跑一遍 20261002_cs_chat_recall_ref_push/migration.sql（照 test-migration-number-seq-db.ts 的做法）。
 *
 * 为什么要有：CI 的连库测试是拿 schema.prisma 直接 db push 建库，**完全绕过迁移文件** ——
 * 迁移里列名写错、唯一索引漏了，所有测试照样全绿，上线时订阅系统通知那句「按 endpoint 覆盖」才炸。
 * 上线脚本 deploy.sh 迁移完会跑 scripts/check-schema-drift.sql 体检，这里一并跑一遍。
 *
 * 做法（只在一次性库上跑，要临时建一个数据库）：
 *   1. 新建临时库，按当前 schema.prisma 建好结构；拆掉这份迁移加的东西 = 回到上线前的样子；放一条老消息；
 *   2. 迁移文件连跑两遍（第二遍验证能重复执行）；
 *   3. `prisma migrate diff` 比对库和 schema.prisma：必须一点差异都没有；
 *   4. 上线体检 check-schema-drift.sql：一行都不输出；
 *   5. 老消息一个字没变、新列是空的；删掉临时库。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "apps/api/prisma/schema.prisma");
const MIGRATION = path.join(ROOT, "apps/api/prisma/migrations/20261002_cs_chat_recall_ref_push/migration.sql");
const DRIFT = path.join(ROOT, "scripts/check-schema-drift.sql");
const NEW_MESSAGE_COLUMNS = ["recalled_at", "ref_type", "ref_id", "ref_no", "ref_title"];

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
  const tmpName = `zz_mig_cspush_${Date.now().toString(36)}`;
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
    await db.$executeRawUnsafe(`DROP TABLE "cs_push_subscriptions"`);
    for (const col of NEW_MESSAGE_COLUMNS) await db.$executeRawUnsafe(`ALTER TABLE "cs_messages" DROP COLUMN "${col}"`);
    // 一条老数据：上线前就在的一条消息
    await db.$executeRawUnsafe(`INSERT INTO "users" (id, company_id, role, name, phone, status) VALUES ('ZZMIGP1', 'zz_migp_co', 'client', '老客户', '0', 'active')`);
    await db.$executeRawUnsafe(`INSERT INTO "cs_conversations" (id, company_id, client_id, last_message_at, last_message_preview, last_sender_role, created_at, updated_at)
      VALUES ('zz_migp_conv', 'zz_migp_co', 'ZZMIGP1', '2026-09-30 01:02:03', '老消息', 'client', '2026-09-30 01:02:03', '2026-09-30 01:02:03')`);
    await db.$executeRawUnsafe(`INSERT INTO "cs_messages" (id, company_id, conversation_id, sender_id, sender_role, content, created_at)
      VALUES ('zz_migp_msg', 'zz_migp_co', 'zz_migp_conv', 'ZZMIGP1', 'client', '老消息', '2026-09-30 01:02:03')`);
    const before = await db.$queryRawUnsafe<any[]>(`SELECT * FROM "cs_messages" WHERE id = 'zz_migp_msg'`);

    await check("P1 迁移文件在「上线前的库」上能跑通，而且连跑两遍不报错（可重复执行）", () => {
      for (const n of [1, 2]) {
        const r = prisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION], tmpUrl);
        assert.equal(r.code, 0, `第 ${n} 遍失败：${r.out.slice(-400)}`);
      }
    });

    await check("P2 跑完以后库跟 schema.prisma 一点差异都没有（唯一索引、普通索引、类型全对上）", () => {
      const r = prisma(["migrate", "diff", "--from-url", tmpUrl, "--to-schema-datamodel", SCHEMA, "--script", "--exit-code"], tmpUrl);
      assert.equal(r.code, 0, `还差这些（迁移漏了 / 写错了）：\n${r.out.split("\n").filter((l) => l.trim() && !l.startsWith("--")).slice(0, 12).join("\n")}`);
    });

    await check("P3 上线体检 check-schema-drift.sql 一行都不输出（清单里有新加的 14 个字段，也没多写）", async () => {
      const rows = await db.$queryRawUnsafe<any[]>(readFileSync(DRIFT, "utf8"));
      assert.equal(rows.length, 0, `体检报了：${JSON.stringify(rows).slice(0, 400)}`);
    });

    await check("P4 老消息一个字没变、新列都是空的；同一个浏览器（endpoint）订阅两次只留一行（唯一索引在）", async () => {
      // ⚠️ 查询文字要跟迁移前那句不一样：同一句预编译过的查询在改表结构后再用，库会报「cached plan must not change result type」
      const after = await db.$queryRawUnsafe<any[]>(`SELECT *, 'after' AS zz_phase FROM "cs_messages" WHERE id = 'zz_migp_msg'`);
      assert.equal(after.length, 1);
      for (const [k, v] of Object.entries(before[0])) assert.deepEqual(after[0][k], v, `老数据的 ${k} 被改了`);
      for (const col of NEW_MESSAGE_COLUMNS) assert.equal(after[0][col], null, `新列 ${col} 给老数据填了值`);
      const ins = (id: string, user: string) => db.$executeRawUnsafe(`INSERT INTO "cs_push_subscriptions" (id, company_id, user_id, role, endpoint, p256dh, auth, updated_at)
        VALUES ('${id}', 'zz_migp_co', '${user}', 'client', 'https://push.example/abc', 'k', 'a', now())
        ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id`);
      await ins("zz_p1", "ZZMIGP1");
      await ins("zz_p2", "ZZMIGP2");
      const rows = await db.$queryRawUnsafe<any[]>(`SELECT user_id FROM "cs_push_subscriptions" WHERE endpoint = 'https://push.example/abc'`);
      assert.deepEqual(rows.map((r) => r.user_id), ["ZZMIGP2"], "同一个 endpoint 存成了两行（唯一索引没建上）");
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
