/**
 * 给财务系统2 的只读接口：真 PostgreSQL + 真 HTTP 服务 + 真迁移文件（2026-11-19）。
 *
 * 每次临时建一个空库（db push 刷结构 → 放一条「上线前」的老运单 → 迁移文件连跑两遍），跑完整库删掉，
 * 不碰 DATABASE_URL 指的那个库里的任何数据。所以只许本机 / CI 的一次性库（地址是 localhost）+ AGENT_PORTAL_TEST_ALLOW_DB=1。
 *
 * 覆盖财务系统2 docs/给物流系统的提示词.md「A 部分要加的测试」1～6（第 7 条回归另外跑：物流系统原有的连库测试在装了触发器的库上全跑一遍）：
 *   迁移（两遍不报错、跟 schema 零差异、上线体检不报、老运单补一条且只补一条）
 *   鉴权（不带 / 带错 401、新旧两把 200、没配齐 503、日志里没有密钥、不跑登录解析）
 *   只读（每个接口调一遍前后，库里每张表的行数和内容一个字不变）
 *   格式（字段一个不多一个不少、字符串小数位、时间带 Z、null 不省略、整柜才有 fcl）
 *   约定第 3 节十种情况（真接口建单 / 收货 / 到货通知转运单 / 建整柜 / 删单 / 删整柜），确认收货时间三条路
 *   增量（只改一处就只出现那一票、无关的改动不出现、同一时刻很多票翻页不漏不重、翻页中途又改了也不漏）
 *   删除（删除记录、取一票、从来没有过 404、子运单号认母运单）、公司隔离、客户和代理、换代理记录、记失败不影响原操作
 *
 * 用法：npm run test:finance2-db
 * 设 FINANCE2_SAMPLE_OUT=<文件> 会把真跑出来的样例返回写进去（docs 里贴的就是它）。
 */
process.env.TZ = "UTC";
process.env.AUTH_SECRET ||= "test-only-fake-secret-not-a-real-key-do-not-use-in-production";
process.env.AGENT_REBATE_SCHEDULER = "off";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";

type Row = Record<string, any>;

const CO = "zz_f2_co";
const OTHER_CO = "zz_f2_other";
const WH = "wh_yiwu_01";
const KEY = "Fin4nce2-k3y-aB3dE5gH7jK9mN1pQ3sT5vXyZ";
const OLD_KEY = "0ld-Fin4nce2-k3y-zY8xW6vU4tS2rQ0pO9nM";
const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "apps/api/prisma/schema.prisma");
const MIGRATION = path.join(ROOT, "apps/api/prisma/migrations/20261119_finance2_readonly_api/migration.sql");
const DRIFT = path.join(ROOT, "scripts/check-schema-drift.sql");

const ADMIN = { userId: "zz_f2_admin", companyId: CO, role: "admin" as const, name: "超管ZZF2", agentId: null };
const STAFF = { userId: "zz_f2_staff", companyId: CO, role: "staff" as const, name: "员工ZZF2", agentId: null };
const C_DIRECT = "ZZF2C1";
const C_AGENT = "ZZF2C2";
const C_OTHER = "ZZF2C3";
const AG1 = "zz_f2_ag1";
const AG2 = "zz_f2_ag2";
const CLIENT_AUTH = { userId: C_DIRECT, companyId: CO, role: "client" as const, name: "直属客户ZZF2", agentId: null };

let failures = 0;
let passes = 0;
async function test(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passes++; console.log(`  ✅ ${label}`); }
  catch (e) { failures++; console.log(`  ❌ ${label}\n     ${(e instanceof Error ? e.stack ?? e.message : String(e)).split("\n").slice(0, 12).join("\n     ")}`); }
}

/** 测试期间所有日志接下来，最后查有没有密钥、有没有「认证失败」 */
const captured: string[] = [];
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); original(...args); };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function runPrisma(args: string[], dbUrl: string): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["prisma", ...args], { cwd: ROOT, env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e: any) {
    return { code: typeof e.status === "number" ? e.status : 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：怕连到生产库不跑（确认是测试库再设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  const base = new URL(url);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(base.hostname)) {
    console.log("⚠️ 跳过：这一项要临时建库，只在本机 / CI 的一次性库上跑 —— 这一项等于没测");
    return;
  }

  /* ---------- 临时库：db push → 放上线前的老数据 → 迁移连跑两遍 ---------- */
  const tmpName = `zz_finance2_${Date.now().toString(36)}`;
  const tmp = new URL(url);
  tmp.pathname = `/${tmpName}`;
  const tmpUrl = tmp.toString();
  const admin = new PrismaClient({ datasources: { db: { url } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${tmpName}"`);
  const raw = new PrismaClient({ datasources: { db: { url: tmpUrl } } });
  try {
    const push = runPrisma(["db", "push", `--schema=${SCHEMA}`, "--skip-generate"], tmpUrl);
    assert.equal(push.code, 0, `临时库建结构失败：${push.out.slice(-400)}`);
    // db push 会建好两张新表；把它们拆掉，模拟「上线前的库」
    await raw.$executeRawUnsafe(`DROP TABLE "finance2_waybill_changes"`);
    await raw.$executeRawUnsafe(`DROP TABLE "finance2_customer_agent_changes"`);
    await raw.$executeRawUnsafe(`INSERT INTO users (id, company_id, role, name, phone, status, password_hash) VALUES ('ZZF2OLDC', '${CO}', 'client', '老客户', '000', 'active', 'x')`);
    await raw.$executeRawUnsafe(`INSERT INTO orders (id, company_id, client_id, warehouse_id, item_name, product_quantity, package_count, package_unit, transport_mode, receiver_name_th, receiver_phone_th, receiver_address_th, updated_at, created_at)
      VALUES ('zz_f2_o_old', '${CO}', 'ZZF2OLDC', '${WH}', '老货', 1, 1, '箱', 'sea', '-', '-', '-', '2026-08-01T00:00:00', '2026-07-01T00:00:00')`);
    await raw.$executeRawUnsafe(`INSERT INTO shipments (id, company_id, order_id, tracking_no, current_status, warehouse_id, updated_at) VALUES ('zz_f2_s_old', '${CO}', 'zz_f2_o_old', 'ZZF2OLD1', 'inWarehouseCN', '${WH}', '2026-08-02T00:00:00')`);
    for (const n of [1, 2]) {
      const r = runPrisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION], tmpUrl);
      assert.equal(r.code, 0, `迁移第 ${n} 遍失败：${r.out.slice(-400)}`);
    }

    process.env.DATABASE_URL = tmpUrl;
    process.env.NODE_ENV = "test";
    process.env.IMAGES_DIR = mkdtempSync(path.join(os.tmpdir(), "zz-f2-img-"));
    process.env.FINANCE2_COMPANY_ID = CO;
    process.env.FINANCE2_API_KEY_SHA256 = sha256(KEY);
    process.env.FINANCE2_API_KEY_SHA256_PREV = sha256(OLD_KEY);

    const { prisma } = await import("../apps/api/src/db/prisma");
    const { createApp } = await import("../apps/api/src/server");
    const { registerFinance2Routes } = await import("../apps/api/src/modules/finance2/routes");
    const { WAYBILL_KEYS } = await import("../apps/api/src/modules/finance2/views");
    const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
    const db = prisma as any;

    /* 业务接口：真 handler，假 app（同 test-client-ban-db 的写法） */
    const routes = new Map<string, Function>();
    const fake: any = {};
    for (const m of ["get", "post", "delete"]) fake[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
    (await import("../apps/api/src/modules/orders/routes")).registerOrderRoutes(fake);
    (await import("../apps/api/src/modules/admin/routes")).registerAdminRoutes(fake);
    (await import("../apps/api/src/modules/fcl-containers/routes")).registerFclContainerRoutes(fake);
    (await import("../apps/api/src/modules/arrival-notices/routes")).registerArrivalNoticeRoutes(fake);
    async function must(key: string, auth: Row, body: Row = {}): Promise<any> {
      const handler = routes.get(key);
      assert.ok(handler, `没有这个接口：${key}`);
      let status = 200; let out: any;
      const res: any = { status(s: number) { status = s; return res; }, json(p: any) { out = p; }, setHeader() {} };
      try { await handler!({ method: key.split(" ")[0], body, query: {}, headers: {}, auth, path: key.split(" ")[1] }, res); }
      catch (e) { if (e instanceof BusinessError) { status = e.httpStatus; out = { message: e.message }; } else throw e; }
      assert.equal(status, 200, `${key} 应该成功，实际 ${status}：${out?.message}`);
      return out?.data;
    }

    /* 财务系统2 的接口：真 HTTP 服务（连 server.ts 的路由和登录解析一起测） */
    const PORT = await freePort();
    const app = createApp();
    registerFinance2Routes(app);
    await new Promise<void>((resolve) => app.listen(PORT, resolve));
    const BASE = `http://127.0.0.1:${PORT}`;
    async function f2(p: string, key: string | null = KEY, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: Row; text: string }> {
      const r = await fetch(`${BASE}/integrations/finance2/v1${p}`, { headers: { ...(key === null ? {} : { authorization: `Bearer ${key}` }), ...extraHeaders } });
      const text = await r.text();
      let body: Row = {};
      try { body = JSON.parse(text) as Row; } catch { /* 留空 */ }
      return { status: r.status, body, text };
    }
    async function ok200(p: string): Promise<Row> {
      const r = await f2(p);
      assert.equal(r.status, 200, `${p} → ${r.status} ${r.text.slice(0, 300)}`);
      return r.body;
    }
    /** 从 since 起一页页拉完 changes，返回全部条目（按出现顺序，可能有重复） */
    async function pullChanges(since: string, limit = 500, between?: (page: number) => Promise<void>): Promise<Row[]> {
      const items: Row[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 200; page++) {
        const body = await ok200(`/waybills/changes?since=${encodeURIComponent(since)}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`);
        items.push(...(body.items as Row[]));
        assert.equal(body.hasMore, body.nextCursor !== null);
        if (!body.hasMore) return items;
        cursor = body.nextCursor;
        if (between) await between(page);
      }
      throw new Error("翻了 200 页还没完");
    }
    const latestByNo = (items: Row[]) => { const m = new Map<string, Row>(); for (const it of items) m.set(it.waybillNo, it); return m; };
    /** 现在的数据库时间（接口给的 serverTime），再等 5 毫秒，之后的改动一定比它晚 */
    async function checkpoint(): Promise<string> {
      const t = (await ok200("/agents")).serverTime as string;
      await sleep(5);
      return t;
    }
    async function changedSince(t: string): Promise<string[]> {
      return [...new Set((await pullChanges(t)).map((i) => i.waybillNo as string))].sort();
    }
    const item = async (no: string) => (await ok200(`/waybills/${encodeURIComponent(no)}`)).item as Row;

    /* ---------- 基础数据 ---------- */
    await db.agent.createMany({ data: [
      { id: AG1, companyId: CO, name: "代理一ZZF2", priceNormal: 500, priceInspection: 550, priceSensitive: 600 },
      { id: AG2, companyId: CO, name: "代理二ZZF2", priceNormal: 500, priceInspection: 550, priceSensitive: 600 },
      { id: "zz_f2_ag_other", companyId: OTHER_CO, name: "别家代理", priceNormal: 500, priceInspection: 550, priceSensitive: 600 },
    ] });
    const user = (id: string, role: string, name: string, agentId: string | null = null, companyId = CO, status = "active") =>
      ({ id, companyId, role, name, phone: `0${id}`, status, agentId, passwordHash: "x" });
    await db.user.createMany({ data: [
      user(ADMIN.userId, "admin", ADMIN.name), user(STAFF.userId, "staff", STAFF.name),
      user(C_DIRECT, "client", "直属客户ZZF2"), user(C_AGENT, "client", "代理客户ZZF2", AG1), user(C_OTHER, "client", "停用客户ZZF2", null, CO, "inactive"),
      user("ZZF2X1", "client", "别家客户", null, OTHER_CO),
    ] });

    const staffOrder = (clientId: string, trackingNo: string, extra: Row = {}) => must("POST /staff/orders", STAFF, {
      clientId, trackingNo, itemName: "货", packageCount: 2, transportMode: "sea", warehouseId: WH, arrivedAt: "2026-11-18", ...extra,
    });
    const shipByNo = (no: string) => db.shipment.findFirst({ where: { trackingNo: no }, include: { order: true } });
    const logsOf = (shipmentId: string) => db.statusLog.findMany({ where: { shipmentId }, orderBy: { changedAt: "asc" } });

    console.log("\n【迁移文件】");
    await test("M1 上线前的库上连跑两遍不报错；跟 schema.prisma 零差异；上线体检一行不报；15 个触发器在；老运单补了一条且只补一条", async () => {
      const diff = runPrisma(["migrate", "diff", "--from-url", tmpUrl, "--to-schema-datamodel", SCHEMA, "--script", "--exit-code"], tmpUrl);
      assert.equal(diff.code, 0, `还差这些：\n${diff.out.split("\n").filter((l) => l.trim() && !l.startsWith("--")).slice(0, 12).join("\n")}`);
      const drift = await raw.$queryRawUnsafe<Row[]>(readFileSync(DRIFT, "utf8"));
      assert.equal(drift.length, 0, `上线体检报了：${JSON.stringify(drift).slice(0, 300)}`);
      const triggers = await raw.$queryRawUnsafe<Row[]>(`SELECT tgname FROM pg_trigger WHERE tgname LIKE 'finance2_%' AND NOT tgisinternal`);
      assert.equal(triggers.length, 15);
      const rows = await raw.$queryRawUnsafe<Row[]>(`SELECT source, deleted, to_char(changed_at, 'YYYY-MM-DD HH24:MI') AS at FROM finance2_waybill_changes WHERE waybill_no = 'ZZF2OLD1'`);
      assert.deepEqual(rows, [{ source: "backfill", deleted: false, at: "2026-08-02 00:00" }], "取订单 / 运单最后改动里晚的那个");
      const third = runPrisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION], tmpUrl);
      assert.equal(third.code, 0);
      assert.equal(Number((await raw.$queryRawUnsafe<Row[]>(`SELECT count(*)::int AS n FROM finance2_waybill_changes WHERE waybill_no = 'ZZF2OLD1'`))[0].n), 1, "再跑一遍不补第二条");
    });

    console.log("\n【鉴权】");
    await test("A1 不带密钥 401、带错 401、bearer 小写 401；新的 200、换密钥期间旧的也 200；401 的响应里没有密钥", async () => {
      assert.equal((await f2("/agents", null)).status, 401);
      const wrong = await f2("/agents", "wrong-key-wrong-key-wrong-key-123456");
      assert.equal(wrong.status, 401);
      assert.deepEqual(Object.keys(wrong.body).sort(), ["error", "message"]);
      assert.equal((await f2("/agents", null, { authorization: `bearer ${KEY}` })).status, 401);
      assert.equal((await f2("/waybills/changes?since=2026-01-01T00:00:00Z", KEY.slice(0, -1))).status, 401);
      assert.equal((await f2("/agents", KEY)).status, 200);
      assert.equal((await f2("/agents", OLD_KEY)).status, 200);
      assert.equal((await f2("/waybills/ZZF2OLD1", OLD_KEY)).status, 200, "取一票那种路径也认");
      delete process.env.FINANCE2_API_KEY_SHA256_PREV;
      assert.equal((await f2("/agents", OLD_KEY)).status, 401, "换完删掉旧指纹，旧密钥就不认了");
      process.env.FINANCE2_API_KEY_SHA256_PREV = sha256(OLD_KEY);
    });
    await test("A2 没配齐（公司没填 / 指纹填成密钥本身）一律 503，不管带什么密钥", async () => {
      delete process.env.FINANCE2_COMPANY_ID;
      assert.equal((await f2("/agents")).status, 503);
      process.env.FINANCE2_COMPANY_ID = CO;
      process.env.FINANCE2_API_KEY_SHA256 = KEY;
      assert.equal((await f2("/agents")).status, 503);
      process.env.FINANCE2_API_KEY_SHA256 = sha256(KEY);
      assert.equal((await f2("/agents")).status, 200);
    });

    console.log("\n【约定第 3 节十种情况 + 确认收货三条路】");
    // 3.1 直属客户、单一货型（员工建单 = 确认收货那一刻）
    await staffOrder(C_DIRECT, "ZZF2A001", { volumeM3: 1.234, weightKg: 186.5, products: [{ itemName: "收纳盒", packageCount: 12, lengthCm: 60, widthCm: 40, heightCm: 40, cargoType: "normal" }] });
    // 3.2 代理的客户，陆运
    await staffOrder(C_AGENT, "ZZF2A002", { transportMode: "land", volumeM3: 0.25, weightKg: 31, products: [{ itemName: "服装", packageCount: 3, lengthCm: 50, widthCm: 40, heightCm: 40, cargoType: "normal" }] });
    // 3.3 混货型
    await staffOrder(C_DIRECT, "ZZF2A003", { volumeM3: 0.3, weightKg: 42.8, products: [
      { itemName: "毛巾", packageCount: 2, lengthCm: 50, widthCm: 40, heightCm: 25, cargoType: "normal" },
      { itemName: "充电宝", packageCount: 4, lengthCm: 40, widthCm: 25, heightCm: 25, cargoType: "sensitive" },
    ] });
    // 3.4 没有产品明细：现在员工建单没填产品也会补一行，老单才没有 —— 建完把产品行删掉，模拟 2026-07 以前的老单
    await staffOrder(C_DIRECT, "ZZF2A004", { itemName: "杂货", packageCount: 20, cargoType: "special", volumeM3: 2.05 });
    await db.orderProduct.deleteMany({ where: { order: { shipments: { some: { trackingNo: "ZZF2A004" } } } } });
    // 3.5 分两批装两个柜：真建单，再按物流系统分柜后的样子造子运单、柜子、装柜明细、轨迹
    await staffOrder(C_AGENT, "ZZF2A005", { volumeM3: 5.6, weightKg: 720, products: [{ itemName: "塑料凳", packageCount: 40, lengthCm: 70, widthCm: 50, heightCm: 40, cargoType: "normal" }] });
    const m5 = await shipByNo("ZZF2A005");
    await db.container.createMany({ data: [
      { id: "zz_f2_ct1", companyId: CO, containerNo: "ZZFU1234567", containerType: "40HQ", currentStatus: "IN_TRANSIT" },
      { id: "zz_f2_ct2", companyId: CO, containerNo: "ZZGU7654321", containerType: "40HQ", currentStatus: "LOADING" },
    ] });
    await db.shipment.createMany({ data: [
      { id: "zz_f2_s5a", companyId: CO, orderId: m5.orderId, trackingNo: "ZZF2A005-1", parentTrackingNo: "ZZF2A005", currentStatus: "departed", warehouseId: WH, volumeM3: 3.5, packageCount: 25 },
      { id: "zz_f2_s5b", companyId: CO, orderId: m5.orderId, trackingNo: "ZZF2A005-2", parentTrackingNo: "ZZF2A005", currentStatus: "loaded", warehouseId: WH, volumeM3: null, packageCount: 15 },
    ] });
    await db.shipment.update({ where: { id: m5.id }, data: { currentStatus: "departed", packageCount: 0, volumeM3: 0 } });
    await db.shipmentContainerItem.createMany({ data: [
      { shipmentId: "zz_f2_s5a", containerId: "zz_f2_ct1", loadedVolumeM3: 3.5, loadedPieceCount: 25, createdAt: new Date("2026-11-12T11:30:00Z") },
      { shipmentId: "zz_f2_s5b", containerId: "zz_f2_ct2", loadedVolumeM3: 2.1, loadedPieceCount: 15, createdAt: new Date("2026-11-14T12:10:00Z") },
    ] });
    const slog = (id: string, shipmentId: string, toStatus: string, at: string) =>
      ({ id, companyId: CO, shipmentId, operatorId: STAFF.userId, operatorRole: "staff", operatorName: "员工ZZF2", fromStatus: "x", toStatus, changedAt: new Date(at), remark: "内部备注ZZF2" });
    await db.statusLog.createMany({ data: [
      slog("zz_f2_l5a", "zz_f2_s5a", "loaded", "2026-11-12T11:30:00Z"), slog("zz_f2_l5b", "zz_f2_s5a", "departed", "2026-11-17T15:00:00Z"),
      slog("zz_f2_l5c", "zz_f2_s5b", "loaded", "2026-11-14T12:10:00Z"), slog("zz_f2_l5d", m5.id, "departed", "2099-01-01T00:00:00Z"),
    ] });
    // 3.6 整柜（真接口建）
    const fcl = await must("POST /staff/fcl-containers/create", STAFF, {
      clientId: C_DIRECT, trackingNo: "ZZF2FCL1", containerNo: "ZZFC7654321", containerType: "40HQ", transportMode: "sea", warehouseId: WH,
      loadingDate: "2026-11-05", amountCny: "28000", remark: "整柜备注",
      products: [{ itemName: "家具", packageCount: 10, quantityPerBox: 1, lengthCm: 100, widthCm: 50, heightCm: 50, unitWeightKg: 20, domesticTrackingNo: "SF9", cargoType: "normal" }],
    });
    // 3.7 确认后体积要变的那一票
    await staffOrder(C_DIRECT, "ZZF2A007", { volumeM3: 0.8, weightKg: 95, cargoType: "inspection", products: [{ itemName: "小家电", packageCount: 5, lengthCm: 60, widthCm: 50, heightCm: 50, cargoType: "inspection" }] });
    // 3.8 要取消的、3.9 要删的
    await staffOrder(C_AGENT, "ZZF2A008", { volumeM3: 0.6 });
    await staffOrder(C_AGENT, "ZZF2A009", { volumeM3: 0.6 });
    // 3.10 客户预报单（真接口）；确认收货第 2 条路：仓库点「确认收货」
    const pre = await must("POST /client/prealerts", CLIENT_AUTH, { warehouseId: WH, transportMode: "sea", products: [{ itemName: "文具", packageCount: 3 }] });
    const preShip = await db.shipment.findFirst({ where: { orderId: pre.prealertId, parentTrackingNo: null } });
    // 确认收货第 3 条路：到货通知转待入库 → 转正式运单
    const notice = (await must("POST /staff/arrival-notices/save", STAFF, {
      clientId: C_DIRECT, trackingNo: "ZZF2N001", transportMode: "sea", warehouseId: WH, arrivedAt: "2026-11-18",
      products: [{ itemName: "灯具", packageCount: "2", lengthCm: "40", widthCm: "40", heightCm: "40", weightKg: "10", cargoType: "normal", domesticTrackingNo: "SF1" }],
    })).item;
    await must("POST /staff/arrival-notices/convert", STAFF, { id: notice.id, to: "inbound" });
    // 别家公司的单：一律看不到
    await db.order.create({ data: { id: "zz_f2_o_x", companyId: OTHER_CO, clientId: "ZZF2X1", warehouseId: WH, itemName: "别家", productQuantity: 1, packageCount: 1, packageUnit: "箱", transportMode: "sea", receiverNameTh: "-", receiverPhoneTh: "-", receiverAddressTh: "-" } });
    await db.shipment.create({ data: { id: "zz_f2_s_x", companyId: OTHER_CO, orderId: "zz_f2_o_x", trackingNo: "ZZF2X001", currentStatus: "inWarehouseCN", warehouseId: WH } });

    const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    function checkFormat(w: Row): void {
      assert.deepEqual(Object.keys(w), [...WAYBILL_KEYS], `${w.waybillNo} 字段对不上`);
      const dec = (v: unknown, digits: number, label: string) => {
        if (v === null) return;
        assert.equal(typeof v, "string", `${w.waybillNo} ${label} 不是字符串：${JSON.stringify(v)}`);
        assert.match(v as string, new RegExp(`^\\d+\\.\\d{${digits}}$`), `${w.waybillNo} ${label}=${v}`);
      };
      const time = (v: unknown, label: string) => { if (v !== null) assert.match(v as string, ISO_Z, `${w.waybillNo} ${label}=${v}`); };
      dec(w.volumeCbm, 3, "volumeCbm"); dec(w.weightKg, 2, "weightKg");
      assert.ok(w.pieces === null || Number.isInteger(w.pieces));
      for (const p of w.products) {
        dec(p.volumeCbm, 6, "products.volumeCbm");
        for (const k of ["lengthCm", "widthCm", "heightCm"]) if (p[k] !== null) assert.match(p[k], /^\d+(\.\d+)?$/, `${k}=${p[k]}`);
        assert.ok(Number.isInteger(p.pieces));
      }
      for (const c of w.containers) { dec(c.volumeCbm, 3, "containers.volumeCbm"); time(c.loadedAt, "loadedAt"); }
      for (const s of w.splits) { dec(s.volumeCbm, 3, "splits.volumeCbm"); time(s.statusChangedAt, "splits.statusChangedAt"); }
      for (const h of w.statusHistory) time(h.at, "statusHistory.at");
      for (const k of ["statusChangedAt", "warehouseConfirmedAt", "signedAt", "createdAt", "changedAt", "deletedAt"]) time(w[k], k);
      assert.ok(w.changedAt !== null);
      if (w.isFcl) {
        assert.ok(w.fcl, "isFcl=true 时 fcl 不能空");
        dec(w.fcl.amountCny, 2, "fcl.amountCny");
        if (w.fcl.loadingDate !== null) assert.match(w.fcl.loadingDate, /^\d{4}-\d{2}-\d{2}$/);
      } else {
        assert.equal(w.fcl, null, "isFcl=false 时 fcl 必须 null");
      }
      assert.doesNotMatch(JSON.stringify(w), /内部备注ZZF2|员工ZZF2|超管ZZF2|整柜备注|operator/, "轨迹备注 / 操作人一个字都不许出去");
    }

    const all = latestByNo(await pullChanges("2000-01-01T00:00:00Z"));

    await test("C0 全量拉一遍：本公司每一票都在（含上线前的老单），别家公司的一票都没有；每票格式都对", async () => {
      for (const no of ["ZZF2OLD1", "ZZF2A001", "ZZF2A002", "ZZF2A003", "ZZF2A004", "ZZF2A005", "ZZF2FCL1", "ZZF2A007", "ZZF2A008", "ZZF2A009", preShip.trackingNo, "ZZF2N001"]) {
        assert.ok(all.has(no), `少了 ${no}`);
      }
      assert.ok(!all.has("ZZF2X001"));
      assert.ok(![...all.keys()].some((no) => no.includes("-")), "子运单号不单独出现");
      for (const w of all.values()) checkFormat(w);
      assert.equal((await f2("/waybills/ZZF2X001")).status, 404, "别家公司的号当没有");
    });

    await test("C1 直属客户、单一货型、员工建单：确认收货 = 建单那条 inWarehouseCN 轨迹；产品方数 6 位、整票 3 位（员工建单按产品行算整票方数）", async () => {
      const w = all.get("ZZF2A001")!;
      const s = await shipByNo("ZZF2A001");
      const logs = await logsOf(s.id);
      assert.deepEqual({ ...w, products: w.products.map(({ productLineId: _p, ...rest }: Row) => rest), statusChangedAt: null, statusHistory: null, warehouseConfirmedAt: null, createdAt: null, changedAt: null }, {
        waybillNo: "ZZF2A001", customerMark: C_DIRECT, agentId: null, warehouseCode: WH, transportMode: "sea", cargoType: "normal",
        volumeCbm: "1.152", weightKg: "186.50", pieces: 12,
        products: [{ cargoType: "normal", name: "收纳盒", lengthCm: "60", widthCm: "40", heightCm: "40", pieces: 12, volumeCbm: "1.152000" }],
        approvalStatus: "approved", status: "inWarehouseCN", statusChangedAt: null, statusHistory: null, warehouseConfirmedAt: null, signedAt: null,
        isFcl: false, fcl: null, containers: [], splits: [], createdAt: null, changedAt: null, deletedAt: null,
      });
      const inWh = logs.filter((l: Row) => l.toStatus === "inWarehouseCN");
      assert.equal(inWh.length, 1);
      assert.equal(w.warehouseConfirmedAt, inWh[0].changedAt.toISOString());
      assert.deepEqual(w.statusHistory, logs.map((l: Row) => ({ status: l.toStatus, at: l.changedAt.toISOString() })));
      assert.equal(w.createdAt, s.order.createdAt.toISOString());
      const product = await db.orderProduct.findFirst({ where: { orderId: s.orderId } });
      assert.equal(w.products[0].productLineId, product.id);
    });

    await test("C2 代理的客户、陆运：agentId 是客户现在的代理", async () => {
      const w = all.get("ZZF2A002")!;
      assert.equal(w.agentId, AG1);
      assert.equal(w.transportMode, "land");
      assert.equal(w.volumeCbm, "0.240", "员工建单按产品行算整票方数");
      assert.equal(w.products[0].volumeCbm, "0.240000");
    });

    await test("C3 混货型：两款各自货型和方数，按录入顺序", async () => {
      const w = all.get("ZZF2A003")!;
      assert.deepEqual(w.products.map((p: Row) => [p.name, p.cargoType, p.volumeCbm]), [["毛巾", "normal", "0.100000"], ["充电宝", "sensitive", "0.100000"]]);
    });

    await test("C4 没有产品明细的单：products 是 []、整票货型 special、没填重量给 null", async () => {
      const w = all.get("ZZF2A004")!;
      assert.deepEqual(w.products, []);
      assert.equal(w.cargoType, "special");
      assert.equal(w.volumeCbm, "2.050");
      assert.equal(w.weightKg, null);
      assert.equal(w.pieces, 20);
    });

    await test("C5 分两批装两个柜：splits 两张（没存方数的按件数补算）、containers 两条带子运单号；整票体积还是 5.600", async () => {
      const w = all.get("ZZF2A005")!;
      assert.equal(w.volumeCbm, "5.600");
      assert.equal(w.status, "departed");
      assert.deepEqual(w.containers, [
        { containerNo: "ZZFU1234567", trackingNo: "ZZF2A005-1", volumeCbm: "3.500", pieces: 25, loadedAt: "2026-11-12T11:30:00.000Z" },
        { containerNo: "ZZGU7654321", trackingNo: "ZZF2A005-2", volumeCbm: "2.100", pieces: 15, loadedAt: "2026-11-14T12:10:00.000Z" },
      ]);
      assert.deepEqual(w.splits, [
        { trackingNo: "ZZF2A005-1", status: "departed", statusChangedAt: "2026-11-17T15:00:00.000Z", volumeCbm: "3.500", pieces: 25 },
        { trackingNo: "ZZF2A005-2", status: "loaded", statusChangedAt: "2026-11-14T12:10:00.000Z", volumeCbm: "2.100", pieces: 15 },
      ]);
      assert.equal(w.statusChangedAt, "2099-01-01T00:00:00.000Z");
      assert.equal(w.isFcl, false);
    });

    await test("C6 整柜（真接口建）：isFcl、柜号柜型、装柜日期、金额 28000.00；装柜明细带运单号", async () => {
      const w = all.get("ZZF2FCL1")!;
      assert.equal(w.isFcl, true);
      assert.deepEqual(w.fcl, { containerNo: "ZZFC7654321", containerType: "40HQ", loadingDate: "2026-11-05", amountCny: "28000.00" });
      assert.equal(w.containers.length, 1);
      assert.equal(w.containers[0].containerNo, "ZZFC7654321");
      assert.equal(w.containers[0].trackingNo, "ZZF2FCL1");
      assert.ok(fcl.containerId);
    });

    await test("C7 确认收货后体积变了：同一票再出现、changedAt 变新、确认收货时间不变；卸柜退回仓里（又一条 inWarehouseCN）也不改确认收货时间", async () => {
      const before = all.get("ZZF2A007")!;
      const t = await checkpoint();
      const s = await shipByNo("ZZF2A007");
      await must("POST /admin/orders/update", ADMIN, { orderId: s.orderId, volumeM3: 0.95 });
      await db.statusLog.create({ data: slog("zz_f2_l7", s.id, "inWarehouseCN", new Date(Date.now() + 60_000).toISOString()) });
      const after = latestByNo(await pullChanges(t)).get("ZZF2A007");
      assert.ok(after, "改了体积没出现在 changes 里");
      assert.equal(before.volumeCbm, "0.750", "建单时按产品行算");
      assert.equal(after!.volumeCbm, "0.950");
      assert.ok(after!.changedAt > before.changedAt);
      assert.equal(after!.warehouseConfirmedAt, before.warehouseConfirmedAt);
    });

    await test("C8 被取消：状态 cancelled，确认收货时间还在", async () => {
      const t = await checkpoint();
      const s = await shipByNo("ZZF2A008");
      await db.shipment.update({ where: { id: s.id }, data: { currentStatus: "cancelled" } });
      await db.statusLog.create({ data: slog("zz_f2_l8", s.id, "cancelled", new Date().toISOString()) });
      const w = latestByNo(await pullChanges(t)).get("ZZF2A008")!;
      assert.equal(w.status, "cancelled");
      assert.ok(w.warehouseConfirmedAt);
      assert.equal(w.statusHistory.at(-1).status, "cancelled");
    });

    await test("C9 后台删订单（真接口）：changes 里出现删除记录（约定 3.9 的样子），取一票给删除记录", async () => {
      const t = await checkpoint();
      const s = await shipByNo("ZZF2A009");
      await must("POST /admin/orders/delete", ADMIN, { orderId: s.orderId });
      const items = (await pullChanges(t)).filter((i) => i.waybillNo === "ZZF2A009");
      assert.ok(items.length >= 1);
      const w = items.at(-1)!;
      checkFormat(w);
      assert.ok(w.deletedAt && w.deletedAt <= w.changedAt);
      assert.deepEqual({ ...w, changedAt: null, deletedAt: null }, {
        waybillNo: "ZZF2A009", customerMark: null, agentId: null, warehouseCode: null, transportMode: null, cargoType: null, volumeCbm: null,
        weightKg: null, pieces: null, products: [], approvalStatus: null, status: null, statusChangedAt: null, statusHistory: [],
        warehouseConfirmedAt: null, signedAt: null, isFcl: false, fcl: null, containers: [], splits: [], createdAt: null, changedAt: null, deletedAt: null,
      });
      assert.deepEqual(await item("ZZF2A009"), w);
    });

    await test("C10 客户预报单：shipped / created、确认收货 null；仓库点「确认收货」（真接口）后 received、确认收货 = 那一刻写的 inWarehouseCN", async () => {
      const w = all.get(preShip.trackingNo)!;
      assert.equal(w.approvalStatus, "shipped");
      assert.equal(w.status, "created");
      assert.equal(w.warehouseConfirmedAt, null);
      const t = await checkpoint();
      await must("POST /staff/prealerts/receive", STAFF, { orderId: pre.prealertId, packageCount: 3 });
      const after = latestByNo(await pullChanges(t)).get(preShip.trackingNo)!;
      assert.equal(after.approvalStatus, "received");
      const inWh = (await logsOf(preShip.id)).filter((l: Row) => l.toStatus === "inWarehouseCN");
      assert.equal(inWh.length, 1);
      assert.equal(after.warehouseConfirmedAt, inWh[0].changedAt.toISOString());
      assert.ok(after.warehouseConfirmedAt > t);
    });

    await test("C11 到货通知转待入库：确认收货 null；转正式运单（真接口）后 = 转正式时写的那条 inWarehouseCN", async () => {
      const w = all.get("ZZF2N001")!;
      assert.equal(w.status, "pendingInbound");
      assert.equal(w.warehouseConfirmedAt, null);
      const t = await checkpoint();
      await must("POST /staff/arrival-notices/convert", STAFF, { id: notice.id, to: "formal" });
      const after = latestByNo(await pullChanges(t)).get("ZZF2N001")!;
      assert.equal(after.status, "inWarehouseCN");
      const s = await shipByNo("ZZF2N001");
      const inWh = (await logsOf(s.id)).filter((l: Row) => l.toStatus === "inWarehouseCN");
      assert.equal(after.warehouseConfirmedAt, inWh[0].changedAt.toISOString());
      assert.ok(after.warehouseConfirmedAt > t);
    });

    await test("C12 整柜管理删整柜（真接口）：出现删除记录；子运单号查得到母运单那一票；从来没有过的号 404", async () => {
      const t = await checkpoint();
      await must("POST /admin/fcl-containers/delete", ADMIN, { containerId: fcl.containerId, confirmContainerNo: "ZZFC7654321" });
      const w = latestByNo(await pullChanges(t)).get("ZZF2FCL1");
      assert.ok(w?.deletedAt, "删整柜没出删除记录");
      assert.equal((await item("ZZF2FCL1")).deletedAt, w!.deletedAt);
      assert.equal((await item("ZZF2A005-2")).waybillNo, "ZZF2A005");
      assert.equal((await f2("/waybills/ZZF2NEVER")).status, 404);
      assert.equal((await f2("/waybills/ZZF2NEVER")).body.error, "not_found");
    });

    console.log("\n【增量】");
    async function onlyThis(label: string, expected: string[], change: () => Promise<void>): Promise<void> {
      await test(label, async () => {
        const t = await checkpoint();
        await change();
        assert.deepEqual(await changedSince(t), [...expected].sort());
      });
    }
    await onlyThis("I1 只改一票的产品明细（长）→ 只有这一票", ["ZZF2A001"], async () => {
      const s = await shipByNo("ZZF2A001");
      await db.orderProduct.updateMany({ where: { orderId: s.orderId }, data: { lengthCm: 61 } });
    });
    await onlyThis("I2 装柜（加一条装柜明细）→ 只有这一票", ["ZZF2A002"], async () => {
      const s = await shipByNo("ZZF2A002");
      await db.shipmentContainerItem.create({ data: { id: "zz_f2_i2", shipmentId: s.id, containerId: "zz_f2_ct2", loadedVolumeM3: 0.25, loadedPieceCount: 3 } });
    });
    await onlyThis("I3 卸柜（删掉那条装柜明细）→ 只有这一票", ["ZZF2A002"], async () => {
      await db.shipmentContainerItem.delete({ where: { id: "zz_f2_i2" } });
    });
    await onlyThis("I4 拆子运单（新子运单挂在母单下）→ 只有母运单那一票", ["ZZF2A003"], async () => {
      const s = await shipByNo("ZZF2A003");
      await db.shipment.create({ data: { id: "zz_f2_s3a", companyId: CO, orderId: s.orderId, trackingNo: "ZZF2A003-1", parentTrackingNo: "ZZF2A003", currentStatus: "inWarehouseCN", warehouseId: WH, packageCount: 1 } });
    });
    await onlyThis("I5 柜子推进（柜里运单一起改状态 + 写轨迹）→ 只有柜里那一票", ["ZZF2A005"], async () => {
      await db.shipment.updateMany({ where: { id: { in: ["zz_f2_s5a"] } }, data: { currentStatus: "arrivedPort" } });
      await db.statusLog.create({ data: slog("zz_f2_l5e", "zz_f2_s5a", "arrivedPort", new Date().toISOString()) });
    });
    await onlyThis("I6 改整柜金额 → 只有这一票", ["ZZF2A004"], async () => {
      const s = await shipByNo("ZZF2A004");
      await db.order.update({ where: { id: s.orderId }, data: { receivableAmountCny: 1234.5 } });
    });
    await onlyThis("I7 改柜号 → 柜里每一票都算改了", ["ZZF2A002", "ZZF2A005"], async () => {
      const s2 = await shipByNo("ZZF2A002");
      await db.shipmentContainerItem.create({ data: { id: "zz_f2_i7", shipmentId: s2.id, containerId: "zz_f2_ct1", loadedVolumeM3: 0.25, loadedPieceCount: 3 } });
      await sleep(5);
      await db.container.update({ where: { id: "zz_f2_ct1" }, data: { containerNo: "ZZFU1234568" } });
    });
    await onlyThis("I8 删一条轨迹 → 只有这一票", ["ZZF2A005"], async () => {
      await db.statusLog.delete({ where: { id: "zz_f2_l5e" } });
    });
    await onlyThis("I9 跟财务无关的列（付款状态、运单备注、国内单号、柜子状态、客户电话、只碰 updated_at）→ 一票都不出现", [], async () => {
      const s = await shipByNo("ZZF2A001");
      await db.order.update({ where: { id: s.orderId }, data: { paymentStatus: "paid", domesticTrackingNo: "SFZZ" } });
      await db.shipment.update({ where: { id: s.id }, data: { remark: "改备注", updatedAt: new Date() } });
      await db.container.update({ where: { id: "zz_f2_ct2" }, data: { currentStatus: "IN_TRANSIT" } });
      await db.user.update({ where: { id: C_DIRECT }, data: { phone: "0999" } });
    });
    await onlyThis("I10 子运单并回母运单（删子运单）→ 只有母运单那一票，不算删除", ["ZZF2A003"], async () => {
      await db.shipment.delete({ where: { id: "zz_f2_s3a" } });
    });
    await test("I11 删子运单那一票没被当成删除：还是正常的运单", async () => {
      assert.equal((await item("ZZF2A003")).deletedAt, null);
    });

    await test("I12 同一时刻改了 30 票：每页 7 条翻完，30 票一票不漏、一票不重，按 changedAt、运单号排好", async () => {
      const t = await checkpoint();
      const nos = Array.from({ length: 30 }, (_, i) => `ZZF2B${String(i).padStart(3, "0")}`);
      await db.order.createMany({ data: nos.map((no) => ({ id: `zz_f2_o_${no}`, companyId: CO, clientId: C_DIRECT, warehouseId: WH, itemName: "批量", productQuantity: 1, packageCount: 1, packageUnit: "箱", transportMode: "sea", receiverNameTh: "-", receiverPhoneTh: "-", receiverAddressTh: "-" })) });
      await db.shipment.createMany({ data: nos.map((no) => ({ id: `zz_f2_s_${no}`, companyId: CO, orderId: `zz_f2_o_${no}`, trackingNo: no, currentStatus: "inWarehouseCN", warehouseId: WH })) });
      const items = await pullChanges(t, 7);
      assert.deepEqual(items.map((i) => i.waybillNo), [...nos].sort(), "一条语句建的，应该正好 30 条、按运单号排");
      const times = new Set(items.map((i) => i.changedAt));
      console.log(`     （30 票落在 ${times.size} 个不同的毫秒上）`);
      for (let i = 1; i < items.length; i++) {
        const a = items[i - 1]; const b = items[i];
        assert.ok(a.changedAt < b.changedAt || (a.changedAt === b.changedAt && Buffer.compare(Buffer.from(a.waybillNo), Buffer.from(b.waybillNo)) < 0), `${a.waybillNo} / ${b.waybillNo} 顺序不对`);
      }
    });

    await test("I13 翻页过程中又有改动：前面已翻过的那票再改、又新建一票，都在后面的页里出现，一票不漏", async () => {
      const t = await checkpoint();
      const nos = Array.from({ length: 12 }, (_, i) => `ZZF2P${String(i).padStart(3, "0")}`);
      for (const no of nos) {
        await db.order.create({ data: { id: `zz_f2_o_${no}`, companyId: CO, clientId: C_DIRECT, warehouseId: WH, itemName: "翻页", productQuantity: 1, packageCount: 1, packageUnit: "箱", transportMode: "sea", receiverNameTh: "-", receiverPhoneTh: "-", receiverAddressTh: "-" } });
        await db.shipment.create({ data: { id: `zz_f2_s_${no}`, companyId: CO, orderId: `zz_f2_o_${no}`, trackingNo: no, currentStatus: "inWarehouseCN", warehouseId: WH } });
      }
      const items = await pullChanges(t, 5, async (page) => {
        if (page !== 0) return;
        await db.shipment.update({ where: { id: `zz_f2_s_${nos[0]}` }, data: { currentStatus: "holdLoading" } });
        await db.order.create({ data: { id: "zz_f2_o_ZZF2P999", companyId: CO, clientId: C_DIRECT, warehouseId: WH, itemName: "翻页中新建", productQuantity: 1, packageCount: 1, packageUnit: "箱", transportMode: "sea", receiverNameTh: "-", receiverPhoneTh: "-", receiverAddressTh: "-" } });
        await db.shipment.create({ data: { id: "zz_f2_s_ZZF2P999", companyId: CO, orderId: "zz_f2_o_ZZF2P999", trackingNo: "ZZF2P999", currentStatus: "inWarehouseCN", warehouseId: WH } });
      });
      const seen = latestByNo(items);
      for (const no of [...nos, "ZZF2P999"]) assert.ok(seen.has(no), `漏了 ${no}`);
      assert.equal(seen.get(nos[0])!.status, "holdLoading", "已翻过又改的那票后面再出现一次，带新状态");
      assert.equal(items.filter((i) => i.waybillNo === nos[0]).length, 2);
    });

    await test("I15 超管改运单号（真接口）：旧号出一条删除记录、新号作为一票出现（确认收货时间、产品跟过去）", async () => {
      const before = await item("ZZF2A004");
      const t = await checkpoint();
      const s = await shipByNo("ZZF2A004");
      await must("POST /admin/orders/update", ADMIN, { orderId: s.orderId, trackingNo: "ZZF2A004R" });
      const got = latestByNo(await pullChanges(t));
      assert.deepEqual([...got.keys()].sort(), ["ZZF2A004", "ZZF2A004R"]);
      assert.ok(got.get("ZZF2A004")!.deletedAt, "旧号要给删除记录");
      const renamed = got.get("ZZF2A004R")!;
      assert.equal(renamed.deletedAt, null);
      assert.equal(renamed.warehouseConfirmedAt, before.warehouseConfirmedAt);
      assert.deepEqual(renamed.statusHistory, before.statusHistory);
      assert.equal((await item("ZZF2A004")).deletedAt, got.get("ZZF2A004")!.deletedAt);
    });

    await test("I14 since / limit / cursor 不对一律 400（不带时区、乱写、0、501、改过的游标）", async () => {
      for (const q of ["", "?since=2026-11-18%2010:00:00", "?since=2026-11-18T10:00:00", "?since=abc", "?since=2026-11-18T10:00:00Z&limit=0", "?since=2026-11-18T10:00:00Z&limit=501", "?since=2026-11-18T10:00:00Z&limit=1.5", "?since=2026-11-18T10:00:00Z&cursor=xyz!", "?since=2026-11-18T10:00:00Z&cursor=e30"]) {
        const r = await f2(`/waybills/changes${q}`);
        assert.equal(r.status, 400, `${q} → ${r.status}`);
        assert.equal(r.body.error, "bad_request");
      }
    });

    console.log("\n【对账、客户、代理】");
    await test("N1 运单号清单：按建单时间翻页（每页 3 条），本公司现存的母运单都在、删掉的不在、别家的不在；changedAt 跟取一票一致", async () => {
      const got: Row[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 100; i++) {
        const body = await ok200(`/waybills/numbers?createdFrom=2000-01-01T00:00:00Z&limit=3${cursor ? `&cursor=${cursor}` : ""}`);
        got.push(...body.items);
        if (!body.hasMore) break;
        cursor = body.nextCursor;
      }
      const nos = got.map((g) => g.waybillNo);
      assert.equal(new Set(nos).size, nos.length, "有重复");
      const expected = (await db.shipment.findMany({ where: { companyId: CO, parentTrackingNo: null }, select: { trackingNo: true } })).map((s: Row) => s.trackingNo).sort();
      assert.deepEqual([...nos].sort(), expected);
      assert.ok(!nos.includes("ZZF2A009") && !nos.includes("ZZF2X001"));
      for (const g of got) assert.deepEqual(Object.keys(g), ["waybillNo", "changedAt", "deletedAt"]);
      const one = got.find((g) => g.waybillNo === "ZZF2A001")!;
      assert.equal(one.changedAt, (await item("ZZF2A001")).changedAt);
      const window = await ok200(`/waybills/numbers?createdFrom=2026-07-01T00:00:00Z&createdTo=2026-07-02T00:00:00Z`);
      assert.deepEqual(window.items.map((i: Row) => i.waybillNo), ["ZZF2OLD1"]);
      assert.equal((await f2("/waybills/numbers?createdFrom=2026-07-02T00:00:00Z&createdTo=2026-07-01T00:00:00Z")).status, 400);
    });

    await test("U1 客户：只有本公司的客户号（员工、超管、别家都没有），停用的 active=false，代理的客户带代理 id；每页 2 条翻完", async () => {
      const got: Row[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 20; i++) {
        const body = await ok200(`/customers?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
        got.push(...body.items);
        if (!body.hasMore) break;
        cursor = body.nextCursor;
      }
      assert.deepEqual(got.map((c) => c.customerMark).sort(), [C_DIRECT, C_AGENT, C_OTHER, "ZZF2OLDC"].sort());
      assert.deepEqual(got.find((c) => c.customerMark === C_AGENT), { customerMark: C_AGENT, name: "代理客户ZZF2", agentId: AG1, active: true });
      assert.equal(got.find((c) => c.customerMark === C_OTHER)!.active, false);
    });

    await test("U2 代理：只有本公司的；客户换代理 → 换代理记录里有一条（从哪个到哪个、什么时候）、客户名单跟着变；运单不因此出现在 changes 里", async () => {
      const agents = await ok200("/agents");
      assert.deepEqual(agents.items, [{ agentId: AG1, name: "代理一ZZF2" }, { agentId: AG2, name: "代理二ZZF2" }]);
      const t = await checkpoint();
      await db.user.update({ where: { id: C_AGENT }, data: { agentId: AG2 } });
      await db.user.update({ where: { id: C_DIRECT }, data: { agentId: AG1 } });
      await db.user.update({ where: { id: STAFF.userId }, data: { name: "员工改名" } });
      const changes = await ok200(`/customers/agent-changes?since=${encodeURIComponent(t)}`);
      assert.deepEqual(changes.items.map(({ changedAt: _c, ...r }: Row) => r), [
        { customerMark: C_AGENT, fromAgentId: AG1, toAgentId: AG2 },
        { customerMark: C_DIRECT, fromAgentId: null, toAgentId: AG1 },
      ]);
      for (const c of changes.items) assert.ok(ISO_Z.test(c.changedAt) && c.changedAt > t);
      const page1 = await ok200(`/customers/agent-changes?since=${encodeURIComponent(t)}&limit=1`);
      assert.equal(page1.items.length, 1);
      const page2 = await ok200(`/customers/agent-changes?since=${encodeURIComponent(t)}&limit=1&cursor=${page1.nextCursor}`);
      assert.equal(page2.items[0].customerMark, C_DIRECT);
      assert.deepEqual(await changedSince(t), []);
      assert.equal((await item("ZZF2A002")).agentId, AG2, "取一票时给的是现在的代理");
      await db.user.update({ where: { id: C_DIRECT }, data: { agentId: null } });
    });

    console.log("\n【只读、安全】");
    await test("R1 每个接口各调一遍，前后库里每张表的行数和内容一个字不变", async () => {
      const tables = (await raw.$queryRawUnsafe<Row[]>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).map((r) => r.tablename as string);
      const snapshot = async () => {
        const out: Record<string, string> = {};
        for (const tbl of tables) {
          const r = await raw.$queryRawUnsafe<Row[]>(`SELECT count(*)::text AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS h FROM "${tbl}" t`);
          out[tbl] = `${r[0].n}:${r[0].h}`;
        }
        return out;
      };
      const before = await snapshot();
      await pullChanges("2000-01-01T00:00:00Z", 3);
      await ok200("/waybills/numbers?createdFrom=2000-01-01T00:00:00Z");
      for (const no of ["ZZF2A001", "ZZF2A005-1", "ZZF2A009"]) await item(no);
      await f2("/waybills/ZZF2NEVER");
      await ok200("/customers");
      await ok200("/customers/agent-changes?since=2000-01-01T00:00:00Z");
      await ok200("/agents");
      await f2("/agents", "bad-key-bad-key-bad-key-bad-key-0000");
      assert.deepEqual(await snapshot(), before);
    });

    await test("R2 查库的事务真是只读的：在里面写会被数据库拒绝", async () => {
      const { readOnlySnapshot } = await import("../apps/api/src/modules/finance2/load");
      await assert.rejects(readOnlySnapshot(async (tx) => { await tx.$executeRawUnsafe(`UPDATE users SET name = name WHERE id = '${C_DIRECT}'`); }), /read-only/);
    });

    await test("R3 记改动失败（改动记录表插不进去）只发警告，原来的写操作照常成功", async () => {
      await raw.$executeRawUnsafe(`ALTER TABLE finance2_waybill_changes ADD CONSTRAINT zz_f2_fail CHECK (false) NOT VALID`);
      try {
        const s = await shipByNo("ZZF2A001");
        await db.shipment.update({ where: { id: s.id }, data: { currentStatus: "holdLoading" } });
        await db.statusLog.create({ data: slog("zz_f2_lr3", s.id, "holdLoading", new Date().toISOString()) });
        assert.equal((await shipByNo("ZZF2A001")).currentStatus, "holdLoading");
      } finally {
        await raw.$executeRawUnsafe(`ALTER TABLE finance2_waybill_changes DROP CONSTRAINT zz_f2_fail`);
      }
    });

    await test("R4 日志里没有密钥、没有指纹；财务系统2 的请求不跑登录解析（没有一条「认证失败」）", async () => {
      const text = captured.join("\n");
      for (const secret of [KEY, OLD_KEY, sha256(KEY), sha256(OLD_KEY)]) assert.ok(!text.includes(secret), "日志里出现了密钥或指纹");
      assert.ok(!text.includes("认证失败"), "财务系统2 的请求跑了登录解析");
      assert.ok(text.includes("财务系统2 接口：密钥不对"), "密钥不对要记一句（只记路径）");
    });

    const sampleOut = process.env.FINANCE2_SAMPLE_OUT;
    if (sampleOut) {
      const t0 = "2000-01-01T00:00:00Z";
      const changesPage = await ok200(`/waybills/changes?since=${t0}&limit=2`);
      const samples = {
        "GET /waybills/changes?since=2000-01-01T00:00:00Z&limit=2": changesPage,
        "GET /waybills/ZZF2A005（拆了子运单、装了两个柜）": await ok200("/waybills/ZZF2A005"),
        "GET /waybills/ZZF2A003（混货型）": await ok200("/waybills/ZZF2A003"),
        "GET /waybills/ZZF2A009（被删除）": await ok200("/waybills/ZZF2A009"),
        "GET /waybills/numbers?createdFrom=2026-07-01T00:00:00Z&limit=2": await ok200("/waybills/numbers?createdFrom=2026-07-01T00:00:00Z&limit=2"),
        "GET /customers?limit=2": await ok200("/customers?limit=2"),
        "GET /customers/agent-changes?since=2000-01-01T00:00:00Z": await ok200("/customers/agent-changes?since=2000-01-01T00:00:00Z"),
        "GET /agents": await ok200("/agents"),
      };
      writeFileSync(sampleOut, JSON.stringify(samples, null, 2));
      console.log(`  （样例返回写到 ${sampleOut}）`);
    }

    await prisma.$disconnect();
  } finally {
    await raw.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${tmpName}" WITH (FORCE)`);
    await admin.$disconnect();
  }

  console.log(`\n通过 ${passes}，失败 ${failures}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
