/**
 * 放货时查财务系统2 扣货名单：真 PostgreSQL + 真 HTTP 服务 + 假财务系统2（2026-11-19，第 9 期）。
 *
 * 假财务系统2 = 本进程里起的一个 HTTP 服务，照约定 5.1、5.2 的样例返回；不连真的财务系统。
 * 走真接口：柜子推进、往预约派送的柜子加货、尾端派送出车、重新核对、立即更新名单、状态。
 * 覆盖任务书 B 部分测试 1～7：
 *   名单上的唛头每个入口都拦（母单、子单）、状态没变、提示没金额；整柜推进只扣那几票；
 *   单票放行（连子单）能放、不在名单的照放；从来没取到过名单不拦有提示；超过 1 天有提示；
 *   重新核对 回 false 能放 / 回 true 继续拦 / 超时连不上按本地名单拦并写名单时间；
 *   取名单失败保留上一份；整份替换后旧唛头不再拦；其他状态流转不受影响；开关 off / observe。
 * 老板 2026-11-19 答「放货拦截 1～6」后加（假财务系统2 也收 POST /hold-events，约定第 11 节）：
 *   拆派仓派出去的报 releasedWhileHeld（字段 / 请求头、报不进去下一轮补报、4xx 不再报、observe 也报、off 不报、只补 7 天内）；
 *   取不到名单报 holdListUnavailable（一串失败只报成一次、报不进去下一轮再报）、恢复报一次 holdListRecovered；
 *   开关不填时按 observe / 都没配是 off；试运行记录接口只给管理员；撤销误签收不拦；新迁移跟上一份接着跑两遍零差异。
 *
 * 只连测试库：没设 AGENT_PORTAL_TEST_ALLOW_DB=1 一律不跑；没有 DATABASE_URL 打印「跳过」。
 * 测试数据全在假公司 zz_f2h_co 下，开跑前、跑完后都清干净。迁移文件那一段要临时建库，只在本机一次性库上跑。
 * 用法：npm run test:finance2-holds-db
 */
process.env.TZ = "UTC";
process.env.AUTH_SECRET ||= "test-only-fake-secret-not-a-real-key-do-not-use-in-production";
process.env.AGENT_REBATE_SCHEDULER = "off";
process.env.FINANCE2_HOLDS_SCHEDULER = "off";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { PrismaClient } from "@prisma/client";

type Row = Record<string, any>;

const CO = "zz_f2h_co";
const P = "zz_f2h_";
const SECRET = "F1n2Hold-aB3dE5gH7jK9mN1pQ3sT5vXyZ";
const ROOT = path.join(__dirname, "..");
const SCHEMA = path.join(ROOT, "apps/api/prisma/schema.prisma");
const MIGRATION = path.join(ROOT, "apps/api/prisma/migrations/20261119_finance2_holds/migration.sql");
const MIGRATION_REPORTS = path.join(ROOT, "apps/api/prisma/migrations/20261119_finance2_holds_reports/migration.sql");
const DRIFT = path.join(ROOT, "scripts/check-schema-drift.sql");

const ADMIN = "zz_f2h_admin";
const STAFF = "zz_f2h_staff";
const CLIENT_OK = "zz_f2h_client";
/** 唛头：A 被扣；B 被扣但 B1 单票放行；C 不扣 */
const A = "ZZF2HA";
const B = "ZZF2HB";
const C = "ZZF2HC";
/** 名字不许出现在提示里（显示客户只显示唛头） */
const NAME_A = "欠款客户甲ZZ";

let failures = 0;
let passes = 0;
async function test(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passes++;
    console.log(`  ✅ ${label}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ ${label}\n     ${e instanceof Error ? e.message.split("\n").slice(0, 12).join("\n     ") : String(e)}`);
  }
}

const captured: string[] = [];
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
    original(...args);
  };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** 泰国时间写法（约定样例就是 +07:00） */
function bkk(d: Date): string {
  const t = new Date(d.getTime() + 7 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "");
  return `${t}+07:00`;
}

// ───────────────────────── 假财务系统2 ─────────────────────────
interface FakeReply { status: number; body?: unknown; raw?: string; delayMs?: number }
const fake = {
  list: { status: 200, body: {} } as FakeReply,
  /** 按 (唛头, 运单号) 回核对结果；返回 null = 用 checkDefault */
  check: (_mark: string, _waybill: string | null): FakeReply | null => null,
  requests: [] as Array<{ path: string; auth: string | undefined; query: URLSearchParams }>,
  lastCheckedAt: null as Date | null,
  /** 扣货上报（约定 11）POST /hold-events 回什么；默认 200 收下 */
  events: { status: 200, body: { serverTime: "2026-12-05T10:15:03+07:00", accepted: true } } as FakeReply,
  /** 收到的上报（不算进 requests，免得改了老用例的请求数） */
  posts: [] as Array<{ auth: string | undefined; contentType: string | undefined; body: Row }>,
};
function listBody(generatedAt: Date, holds: string[], released: Array<{ no: string; mark: string }>): unknown {
  return {
    serverTime: bkk(new Date()),
    generatedAt: bkk(generatedAt),
    holds: holds.map((m) => ({ customerMark: m, heldSince: "2026-12-03T00:00:00+07:00" })),
    releasedWaybills: released.map((r) => ({ waybillNo: r.no, customerMark: r.mark, releasedAt: "2026-12-04T15:20:00+07:00" })),
  };
}
/** 核对的回话：checkedAt 带毫秒（同一秒里先扣后放也分得清先后）；at 给了就用它（造「晚到的旧答案」） */
function checkReply(mark: string, waybill: string | null, blocked: boolean, at: Date = new Date()): FakeReply {
  const checkedAt = new Date(at.getTime() + 7 * 3600_000).toISOString().replace(/Z$/, "+07:00");
  fake.lastCheckedAt = at;
  return { status: 200, body: { serverTime: bkk(new Date()), customerMark: mark, waybillNo: waybill, blocked, checkedAt } };
}
async function startFake(): Promise<string> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && u.pathname === "/integrations/logistics/v1/hold-events") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let body: Row = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Row; } catch { /* 留空 */ }
        fake.posts.push({ auth: req.headers.authorization, contentType: req.headers["content-type"], body });
        const reply = req.headers.authorization !== `Bearer ${SECRET}` ? { status: 401, body: { error: "unauthorized" } } as FakeReply : fake.events;
        const send = () => {
          if (res.destroyed) return;
          res.writeHead(reply.status, { "content-type": "application/json; charset=utf-8" });
          res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
        };
        if (reply.delayMs) setTimeout(send, reply.delayMs); else send();
      });
      return;
    }
    fake.requests.push({ path: u.pathname, auth: req.headers.authorization, query: u.searchParams });
    let reply: FakeReply;
    if (req.headers.authorization !== `Bearer ${SECRET}`) reply = { status: 401, body: { error: "unauthorized" } };
    else if (u.pathname === "/integrations/logistics/v1/holds") reply = fake.list;
    else if (u.pathname === "/integrations/logistics/v1/holds/check") {
      const mark = u.searchParams.get("customerMark") ?? "";
      const wb = u.searchParams.get("waybillNo");
      reply = fake.check(mark, wb) ?? checkReply(mark, wb, true);
    } else reply = { status: 404, body: { error: "not_found" } };
    const send = () => {
      if (res.destroyed) return;
      res.writeHead(reply.status, { "content-type": "application/json; charset=utf-8" });
      res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
    };
    if (reply.delayMs) setTimeout(send, reply.delayMs); else send();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：怕连到生产库不跑（确认是测试库再设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }

  const fakeBase = await startFake();
  process.env.FINANCE2_HOLDS_MODE = "enforce";
  process.env.FINANCE2_HOLDS_SECRET = SECRET;
  process.env.FINANCE2_API_BASE = fakeBase;

  const { prisma } = await import("../apps/api/src/db/prisma");
  const { createApp } = await import("../apps/api/src/server");
  const { signAuthToken } = await import("../apps/api/src/modules/auth/token");
  const { hashPassword } = await import("../apps/api/src/modules/auth/crypto-utils");
  const { registerContainerRoutes } = await import("../apps/api/src/modules/containers/routes");
  const { registerLoadingManifestRoutes } = await import("../apps/api/src/modules/loading-manifests/routes");
  const { registerAdminOpsRoutes } = await import("../apps/api/src/modules/admin-ops/routes");
  const { registerFinance2HoldRoutes } = await import("../apps/api/src/modules/finance2-holds/routes");
  const { syncHoldList, runHoldRound } = await import("../apps/api/src/modules/finance2-holds/sync");
  const { retryPendingReports, REPORT_RETRY_WINDOW_MS } = await import("../apps/api/src/modules/finance2-holds/reports");
  const { flushHoldLogs, noteChaipaiRelease, NO_LIST_NOTICE, formatListTime } = await import("../apps/api/src/modules/finance2-holds/gate");

  const db = prisma as any;

  async function cleanup(): Promise<void> {
    await db.finance2HoldLog.deleteMany({});
    await db.finance2HoldClear.deleteMany({});
    await db.finance2Hold.deleteMany({});
    await db.finance2HoldRelease.deleteMany({});
    await db.finance2HoldState.deleteMany({});
    await db.adminLastmileOrder.deleteMany({ where: { companyId: CO } });
    await db.statusLog.deleteMany({ where: { companyId: CO } });
    await db.containerPushEntry.deleteMany({ where: { companyId: CO } });
    await db.containerPushBatch.deleteMany({ where: { companyId: CO } });
    const ships: Array<{ id: string }> = await db.shipment.findMany({ where: { companyId: CO }, select: { id: true } });
    await db.shipmentContainerItem.deleteMany({ where: { shipmentId: { in: ships.map((s) => s.id) } } });
    await db.container.deleteMany({ where: { companyId: CO } });
    await db.shipment.deleteMany({ where: { companyId: CO } });
    await db.orderProduct.deleteMany({ where: { companyId: CO } });
    await db.order.deleteMany({ where: { companyId: CO } });
    await db.user.deleteMany({ where: { companyId: CO } });
  }

  const ago = (h: number) => new Date(Date.now() - h * 3600_000);

  async function seed(): Promise<void> {
    const pw = hashPassword("Test-pass-Zz123456");
    const user = (id: string, role: string, name: string) => ({ id, companyId: CO, role, name, phone: "0800000000", status: "active", passwordHash: pw });
    await db.user.createMany({ data: [
      user(ADMIN, "admin", "管理员ZZ"), user(STAFF, "staff", "员工ZZ"), user(CLIENT_OK, "client", "普通客户ZZ"),
      user(A, "client", NAME_A), user(B, "client", "欠款客户乙ZZ"), user(C, "client", "正常客户丙ZZ"),
    ] });
    const order = (id: string, clientId: string, extra: Row = {}) => ({
      id: `${P}o_${id}`, companyId: CO, clientId, warehouseId: "wh", orderNo: `ZZF2HORD${id}`, itemName: `货${id}`, productQuantity: 1, packageCount: 2, packageUnit: "箱",
      transportMode: "sea", receiverNameTh: "收件人", receiverPhoneTh: "0899998888", receiverAddressTh: "曼谷", approvalStatus: "approved",
      volumeM3: 1, weightKg: 10, receivableAmountCny: 28000, ...extra,
    });
    await db.order.createMany({ data: [
      order("a1", A), order("a2", A), order("a3", A), order("a4", A),
      order("b1", B), order("b2", B), order("c1", C), order("c4", C),
    ] });
    const ship = (id: string, orderId: string, trackingNo: string, currentStatus: string, parentTrackingNo: string | null = null, extra: Row = {}) => ({
      id: `${P}s_${id}`, companyId: CO, orderId: `${P}o_${orderId}`, trackingNo, parentTrackingNo, currentStatus, warehouseId: "wh",
      volumeM3: 1, weightKg: 10, packageCount: 2, transportMode: "sea", ...extra,
    });
    await db.shipment.createMany({ data: [
      ship("a1", "a1", "ZZF2H00A1", "inWarehouseTH"),
      ship("a2", "a2", "ZZF2H00A2", "inWarehouseTH", null, { packageCount: 0 }),
      ship("a2c", "a2", "ZZF2H00A2-1", "inWarehouseTH", "ZZF2H00A2"),
      ship("a3", "a3", "ZZF2H00A3", "customsCleared"),
      ship("a4", "a4", "ZZF2H00A4", "inWarehouseCN"),
      ship("b1", "b1", "ZZF2H00B1", "inWarehouseTH", null, { packageCount: 0 }),
      ship("b1c", "b1", "ZZF2H00B1-1", "inWarehouseTH", "ZZF2H00B1"),
      ship("b2", "b2", "ZZF2H00B2", "inWarehouseTH"),
      ship("c1", "c1", "ZZF2H00C1", "inWarehouseTH"),
      ship("c4", "c4", "ZZF2H00C4", "inWarehouseCN"),
    ] });
    const dates = (upto: string[]) => JSON.stringify(Object.fromEntries(upto.map((s, i) => [s, new Date(Date.now() - (upto.length - i) * 86400_000).toISOString()])));
    const SEA = ["SEALED", "IN_TRANSIT", "ARRIVED", "CUSTOMS", "CUSTOMS_CLEARED", "UNLOADING", "IN_WAREHOUSE_TH"];
    await db.container.createMany({ data: [
      { id: `${P}ct_wh`, companyId: CO, containerNo: "ZZFU2000001", containerType: "40HQ", currentStatus: "IN_WAREHOUSE_TH", transportMode: "sea", statusDates: dates(SEA) },
      { id: `${P}ct_cc`, companyId: CO, containerNo: "ZZFU2000002", containerType: "40HQ", currentStatus: "CUSTOMS_CLEARED", transportMode: "sea", statusDates: dates(SEA.slice(0, 5)) },
      { id: `${P}ct_db`, companyId: CO, containerNo: "ZZFU2000003", containerType: "40HQ", currentStatus: "DELIVERY_BOOKED", transportMode: "sea", statusDates: dates([...SEA, "DELIVERY_BOOKED"]) },
    ] });
    await db.shipmentContainerItem.createMany({ data: [
      { shipmentId: `${P}s_a1`, containerId: `${P}ct_wh`, loadedVolumeM3: 1, loadedPieceCount: 2 },
      { shipmentId: `${P}s_a2c`, containerId: `${P}ct_wh`, loadedVolumeM3: 1, loadedPieceCount: 2 },
      { shipmentId: `${P}s_b1c`, containerId: `${P}ct_wh`, loadedVolumeM3: 1, loadedPieceCount: 2 },
      { shipmentId: `${P}s_b2`, containerId: `${P}ct_wh`, loadedVolumeM3: 1, loadedPieceCount: 2 },
      { shipmentId: `${P}s_c1`, containerId: `${P}ct_wh`, loadedVolumeM3: 1, loadedPieceCount: 2 },
      { shipmentId: `${P}s_a3`, containerId: `${P}ct_cc`, loadedVolumeM3: 1, loadedPieceCount: 2 },
    ] });
  }

  /** 每组用例从干净数据开始；mode 不给就是 enforce */
  async function fresh(mode: "off" | "observe" | "enforce" = "enforce"): Promise<void> {
    process.env.FINANCE2_HOLDS_MODE = mode;
    await flushHoldLogs();
    await cleanup();
    await seed();
    fake.list = { status: 200, body: listBody(ago(0.1), [A, B], [{ no: "ZZF2H00B1", mark: B }]) };
    fake.check = () => null;
    fake.requests = [];
    fake.events = { status: 200, body: { serverTime: bkk(new Date()), accepted: true } };
    fake.posts = [];
  }

  const PORT = await freePort();
  const app = createApp();
  registerContainerRoutes(app);
  registerLoadingManifestRoutes(app);
  registerAdminOpsRoutes(app);
  registerFinance2HoldRoutes(app);
  await new Promise<void>((resolve) => app.listen(PORT, resolve));
  const BASE = `http://127.0.0.1:${PORT}`;
  let ipCounter = 0;
  interface Res { status: number; body: Row; text: string }
  async function call(method: string, p: string, who: string, role: string, body?: unknown): Promise<Res> {
    const token = signAuthToken({ userId: who, companyId: CO, role: role as any, userName: who });
    const r = await fetch(`${BASE}${p}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-real-ip": `10.88.0.${(++ipCounter % 250) + 1}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let parsed: Row = {};
    try { parsed = JSON.parse(text) as Row; } catch { /* 留空 */ }
    return { status: r.status, body: parsed, text };
  }
  const admin = (m: string, p: string, b?: unknown) => call(m, p, ADMIN, "admin", b);
  const staff = (m: string, p: string, b?: unknown) => call(m, p, STAFF, "staff", b);
  const statusOf = async (no: string) => (await db.shipment.findUnique({ where: { trackingNo: no }, select: { currentStatus: true } }))?.currentStatus;
  const pushWh = () => staff("POST", "/admin/containers/status", { id: `${P}ct_wh`, toStatus: "DELIVERY_BOOKED" });
  const dispatch = (nos: string[]) => (async () => {
    const ids = (await db.shipment.findMany({ where: { trackingNo: { in: nos } }, select: { id: true } })).map((s: Row) => s.id);
    return staff("POST", "/admin/lastmile/orders", { shipmentIds: ids, driverName: "司机ZZ", licensePlate: "1กข1234", phoneNumber: "0811111111" });
  })();
  const addToDb = (no: string) => staff("POST", `/staff/loading-manifests/add-shipment?id=${P}ct_db`, { trackingNo: no });
  const recheck = (no: string, who: "staff" | "admin" = "staff") => (who === "staff" ? staff : admin)("POST", "/admin/finance2-holds/recheck", { trackingNo: no });
  const sync = async () => { const r = await syncHoldList({ retryDelaysMs: [] }); await flushHoldLogs(); return r; };
  const logs = async (kind?: string) => { await flushHoldLogs(); return db.finance2HoldLog.findMany({ where: kind ? { kind } : {}, orderBy: { createdAt: "asc" } }); };
  /** 拦货的话：【扣货】开头、带唛头和名单时间、不带名字 / 金额 / 「派送中」（前端见到「派送中」会当改派弹框） */
  function assertHoldMessage(msg: string, marks: string[]): void {
    assert.ok(msg.startsWith("【扣货】"), msg);
    assert.match(msg, /这家客户有欠款，放货前请联系财务|这几家客户有欠款，放货前请联系财务/);
    for (const m of marks) assert.ok(msg.includes(m), `话里没有唛头 ${m}：${msg}`);
    assert.match(msg, /按 \d{4}-\d{2}-\d{2} \d{2}:\d{2}（泰国时间）的名单/);
    assert.ok(!msg.includes("派送中"), `话里有「派送中」：${msg}`);
    assert.ok(!msg.includes(NAME_A) && !/28000|28,000|¥|金额/.test(msg), `话里有名字或金额：${msg}`);
  }

  try {
    await cleanup();

    console.log("\n【从来没取到过名单】");
    await fresh();
    await test("N1 没有名单：柜子推到预约派送全都推了；回的话带「现在没有扣货名单」；状态接口也提示", async () => {
      const r = await pushWh();
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.data.affectedShipmentCount, 5);
      assert.deepEqual(r.body.data.heldShipments, []);
      assert.equal(r.body.data.holdNotice, NO_LIST_NOTICE);
      for (const no of ["ZZF2H00A1", "ZZF2H00A2-1", "ZZF2H00B2"]) assert.equal(await statusOf(no), "deliveryBooked");
      const s = await staff("GET", "/admin/finance2-holds/status");
      assert.equal(s.status, 200, s.text);
      assert.equal(s.body.data.mode, "enforce");
      assert.equal(s.body.data.listGeneratedAt, null);
      assert.equal(s.body.data.notice, NO_LIST_NOTICE);
    });
    await test("N2 没有名单：尾端派送照常出车，回话里带「现在没有扣货名单」（页面开着时才开开关，那一块还没出来也能看到）", async () => {
      await fresh();
      const r = await dispatch(["ZZF2H00A1"]);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.data.holdNotice, NO_LIST_NOTICE);
      assert.equal(await statusOf("ZZF2H00A1"), "outForDelivery");
    });

    console.log("\n【取名单】");
    await fresh();
    await test("F1 取到名单：带密钥（请求头，不在地址里）、整份存下、记名单时间、记日志；状态接口写「按几点的名单」", async () => {
      const gen = ago(0.2);
      fake.list = { status: 200, body: listBody(gen, [A, B], [{ no: "ZZF2H00B1", mark: B }]) };
      const r = await sync();
      assert.equal(r.kind, "ok");
      assert.equal(fake.requests.length, 1);
      assert.equal(fake.requests[0].path, "/integrations/logistics/v1/holds");
      assert.equal(fake.requests[0].auth, `Bearer ${SECRET}`);
      assert.equal(fake.requests[0].query.toString(), "");
      assert.deepEqual((await db.finance2Hold.findMany({ orderBy: { customerMark: "asc" } })).map((h: Row) => h.customerMark), [A, B]);
      assert.deepEqual((await db.finance2HoldRelease.findMany()).map((h: Row) => h.waybillNo), ["ZZF2H00B1"]);
      const st = await db.finance2HoldState.findUnique({ where: { id: "current" } });
      assert.equal(Math.floor(st.generatedAt.getTime() / 1000), Math.floor(gen.getTime() / 1000));
      assert.ok((await logs("fetch_ok")).length === 1);
      const s = await staff("GET", "/admin/finance2-holds/status");
      assert.equal(s.body.data.notice, null);
      assert.equal(s.body.data.listLabel, `按 ${formatListTime(st.generatedAt)}（泰国时间）的名单`);
    });

    console.log("\n【入口 1：柜子推到预约派送 —— 被扣的那几票不推、其余照推、单独列出来】");
    await test("C1 A（母单、子单）和 B2 没推、状态没变、没写轨迹没进账本；B1 的子单（母单放行）和 C 照推；父单 A2 不动", async () => {
      const r = await pushWh();
      assert.equal(r.status, 200, r.text);
      const d = r.body.data;
      assert.equal(d.affectedShipmentCount, 2);
      assert.deepEqual(d.heldShipments.map((h: Row) => h.trackingNo).sort(), ["ZZF2H00A1", "ZZF2H00A2-1", "ZZF2H00B2"]);
      assertHoldMessage(d.holdMessage, [A, B]);
      assert.ok(!r.text.includes(NAME_A));
      for (const no of ["ZZF2H00A1", "ZZF2H00A2-1", "ZZF2H00B2", "ZZF2H00A2"]) assert.equal(await statusOf(no), "inWarehouseTH", no);
      for (const no of ["ZZF2H00B1-1", "ZZF2H00C1"]) assert.equal(await statusOf(no), "deliveryBooked", no);
      const heldIds = [`${P}s_a1`, `${P}s_a2c`, `${P}s_b2`];
      assert.equal(await db.statusLog.count({ where: { shipmentId: { in: heldIds } } }), 0);
      assert.equal(await db.containerPushEntry.count({ where: { shipmentId: { in: heldIds } } }), 0);
      assert.equal(await db.container.findUnique({ where: { id: `${P}ct_wh` } }).then((c: Row) => c.currentStatus), "DELIVERY_BOOKED");
      const blocks = await logs("block");
      assert.deepEqual(blocks.map((l: Row) => l.trackingNo).sort(), ["ZZF2H00A1", "ZZF2H00A2-1", "ZZF2H00B2"]);
      assert.ok(blocks.every((l: Row) => l.entry === "柜子推进" && l.operatorId === STAFF && l.listGeneratedAt));
      assert.equal(blocks.find((l: Row) => l.trackingNo === "ZZF2H00A2-1").waybillNo, "ZZF2H00A2", "子单的日志要记母运单号");
    });
    await test("C2 状态接口「我最近被拦的」列出这三票（带唛头、入口）；别的员工看不到我的", async () => {
      const s = await staff("GET", "/admin/finance2-holds/status");
      assert.deepEqual(s.body.data.recent.map((x: Row) => x.trackingNo).sort(), ["ZZF2H00A1", "ZZF2H00A2-1", "ZZF2H00B2"]);
      assert.equal(s.body.data.recent.find((x: Row) => x.trackingNo === "ZZF2H00A2-1").motherTrackingNo, "ZZF2H00A2");
      const other = await admin("GET", "/admin/finance2-holds/status");
      assert.deepEqual(other.body.data.recent, []);
    });
    await test("C3 钱付了：扣下的几票还停在「已到仓」，直接在尾端派送出车（装柜页的下拉没有再推一次预约派送）", async () => {
      fake.list = { status: 200, body: listBody(ago(0.05), [B], []) };
      await sync();
      const r = await dispatch(["ZZF2H00A1", "ZZF2H00A2-1"]);
      assert.equal(r.status, 200, r.text);
      assert.equal(await statusOf("ZZF2H00A1"), "outForDelivery");
      assert.equal((await dispatch(["ZZF2H00B2"])).status, 409);
    });
    await test("C5 直接调接口同状态再推：已经在预约派送的票不再查（不算新放出去）", async () => {
      const r = await pushWh();
      assert.equal(r.status, 200, r.text);
      assert.ok(!r.body.data.heldShipments.some((h: Row) => h.trackingNo === "ZZF2H00B1-1" || h.trackingNo === "ZZF2H00C1"));
      assert.deepEqual(r.body.data.heldShipments.map((h: Row) => h.trackingNo), ["ZZF2H00B2"]);
    });
    await test("C4 其他环节不拦：清关放行的柜推到「正在卸柜」，名单上的 A3 照推", async () => {
      await fresh();
      await sync();
      const r = await staff("POST", "/admin/containers/status", { id: `${P}ct_cc`, toStatus: "UNLOADING" });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.data.affectedShipmentCount, 1);
      assert.deepEqual(r.body.data.heldShipments, []);
      assert.equal(r.body.data.holdMessage, null);
      assert.equal(await statusOf("ZZF2H00A3"), "unloading");
      assert.equal((await logs("block")).length, 0);
    });

    console.log("\n【入口 2：尾端派送出车 —— 有被扣的整车不建】");
    await fresh();
    await sync();
    await test("D1 A1 + C1 一车：409，整车没建、两票都没动；话不带「派送中」", async () => {
      const r = await dispatch(["ZZF2H00A1", "ZZF2H00C1"]);
      assert.equal(r.status, 409, r.text);
      assertHoldMessage(r.body.message, [A]);
      assert.ok(!r.body.message.includes("ZZF2H00C1"));
      assert.equal(await db.adminLastmileOrder.count({ where: { companyId: CO } }), 0);
      assert.equal(await statusOf("ZZF2H00A1"), "inWarehouseTH");
      assert.equal(await statusOf("ZZF2H00C1"), "inWarehouseTH");
    });
    await test("D2 子单 A2-1 也拦（按订单的唛头）", async () => {
      const r = await dispatch(["ZZF2H00A2-1"]);
      assert.equal(r.status, 409, r.text);
      assertHoldMessage(r.body.message, [A]);
      assert.equal(await statusOf("ZZF2H00A2-1"), "inWarehouseTH");
    });
    await test("D3 单票放行：B1 的子单能出车（母单号在放行名单里）；同一家的 B2 照拦", async () => {
      const ok1 = await dispatch(["ZZF2H00B1-1"]);
      assert.equal(ok1.status, 200, ok1.text);
      assert.equal(await statusOf("ZZF2H00B1-1"), "outForDelivery");
      const no = await dispatch(["ZZF2H00B2"]);
      assert.equal(no.status, 409, no.text);
    });
    await test("D4 不在名单上的 C1 照常出车", async () => {
      const r = await dispatch(["ZZF2H00C1"]);
      assert.equal(r.status, 200, r.text);
      assert.equal(await statusOf("ZZF2H00C1"), "outForDelivery");
    });
    await test("D6 本来就在派送中、只是改派换车的不查（货早就出去了）", async () => {
      await db.shipment.update({ where: { trackingNo: "ZZF2H00A1" }, data: { currentStatus: "outForDelivery" } });
      await db.adminLastmileOrder.create({ data: { id: `${P}lm_old`, companyId: CO, deliveryNo: "WDZZF2H01", shipmentId: `${P}s_a1`, carrierName: "自营", driverName: "旧司机", licensePlate: "", phoneNumber: "", deliveryDate: "", externalTrackingNo: "", status: "DELIVERING" } });
      const ids = [`${P}s_a1`];
      const r = await staff("POST", "/admin/lastmile/orders", { shipmentIds: ids, driverName: "新司机ZZ", licensePlate: "2กข", phoneNumber: "0822222222", moveFromDelivering: true });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.data.moved, 1);
      await db.adminLastmileOrder.deleteMany({ where: { companyId: CO, shipmentId: `${P}s_a1` } });
      await db.shipment.update({ where: { trackingNo: "ZZF2H00A1" }, data: { currentStatus: "inWarehouseTH" } });
    });
    await test("D3b 单票放行要唛头也对上（Codex 审查第 4 条）：放行记录的号对、唛头是别人的 → 不算放行", async () => {
      await db.finance2HoldRelease.create({ data: { waybillNo: "ZZF2H00B2", customerMark: C, releasedAt: new Date() } });
      try {
        const r = await dispatch(["ZZF2H00B2"]);
        assert.equal(r.status, 409, r.text);
      } finally {
        await db.finance2HoldRelease.delete({ where: { waybillNo: "ZZF2H00B2" } });
      }
    });
    await test("D5 已签收的再派一趟也查名单（签收后把 A1 改成已签收再派）", async () => {
      await db.shipment.update({ where: { trackingNo: "ZZF2H00A1" }, data: { currentStatus: "delivered" } });
      const r = await dispatch(["ZZF2H00A1"]);
      assert.equal(r.status, 409, r.text);
      assert.equal(await statusOf("ZZF2H00A1"), "delivered");
      await db.shipment.update({ where: { trackingNo: "ZZF2H00A1" }, data: { currentStatus: "inWarehouseTH" } });
    });

    console.log("\n【入口 3：往「预约派送」的柜子加货 —— 被扣的不装】");
    await test("L1 A4 加进预约派送的柜：拦，整个没装（没有子单、没进柜、状态没变）", async () => {
      const r = await addToDb("ZZF2H00A4");
      assert.equal(r.status, 400, r.text);
      assertHoldMessage(r.body.message, [A]);
      assert.equal(await statusOf("ZZF2H00A4"), "inWarehouseCN");
      assert.equal(await db.shipmentContainerItem.count({ where: { containerId: `${P}ct_db` } }), 0);
      assert.equal(await db.shipment.count({ where: { parentTrackingNo: "ZZF2H00A4" } }), 0);
      const blocks = await logs("block");
      assert.ok(blocks.some((l: Row) => l.trackingNo === "ZZF2H00A4" && l.entry === "往预约派送的柜子加货"));
    });
    await test("L2 不在名单上的 C4 照装，补到预约派送", async () => {
      const r = await addToDb("ZZF2H00C4");
      assert.equal(r.status, 200, r.text);
      assert.equal(await statusOf("ZZF2H00C4"), "deliveryBooked");
    });

    console.log("\n【重新核对】");
    await fresh();
    await sync();
    await test("R1 唛头还在扣、这一票老板放了：只放这一票（连子单），同一家别的票照拦", async () => {
      fake.check = (mark, wb) => (mark === A && wb === "ZZF2H00A2" ? checkReply(mark, wb, false) : null);
      const r = await recheck("ZZF2H00A2-1");
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.data.blocked, false);
      assert.ok(fake.requests.some((q) => q.path.endsWith("/holds/check") && q.query.get("waybillNo") === "ZZF2H00A2"), "子单要按母运单号问");
      assert.equal((await dispatch(["ZZF2H00A2-1"])).status, 200);
      assert.equal((await dispatch(["ZZF2H00A1"])).status, 409);
      const rc = await logs("recheck");
      assert.ok(rc.some((l: Row) => l.result.includes("这一票可以放") && l.listGeneratedAt));
    });
    await test("R2 财务说这家不扣了：整个唛头放（直到下一份更新的名单）", async () => {
      fake.check = (mark, wb) => (mark === A && wb === null ? checkReply(mark, wb, false) : null);
      const r = await recheck("ZZF2H00A1");
      assert.equal(r.body.data.blocked, false, r.text);
      assert.equal((await dispatch(["ZZF2H00A1"])).status, 200);
      const s = await staff("GET", "/admin/finance2-holds/status");
      assert.ok(!s.body.data.recent.some((x: Row) => x.customerMark === A), "放了的不再列在「刚才被拦的」");
    });
    await test("R2b 核对结果记的是财务那边的核对时间（不用物流服务器的钟）；放和扣都记", async () => {
      const c = await db.finance2HoldClear.findFirst({ where: { customerMark: A, waybillNo: null }, orderBy: { clearedAt: "desc" } });
      assert.ok(c);
      assert.equal(c.blocked, false);
      assert.equal(c.clearedAt.getTime(), fake.lastCheckedAt!.getTime());
      assert.ok(await db.finance2HoldClear.count({ where: { customerMark: A, waybillNo: null, blocked: true } }) >= 1, "R1 问整家时回的「还扣」也记了");
    });
    await test("R3 新名单比本地的新、但比核对早：替换了，核对留着（还能放）；比核对晚的名单作废核对、照新名单拦", async () => {
      // 先让 A 的别的票能被测：把 A1 退回仓里
      await db.adminLastmileOrder.deleteMany({ where: { companyId: CO } });
      await db.shipment.update({ where: { trackingNo: "ZZF2H00A1" }, data: { currentStatus: "inWarehouseTH" } });
      const stored = (await db.finance2HoldState.findUnique({ where: { id: "current" } })).generatedAt as Date;
      const clear = await db.finance2HoldClear.findFirst({ where: { customerMark: A, waybillNo: null }, orderBy: { clearedAt: "desc" } });
      const between = new Date((stored.getTime() + clear.clearedAt.getTime()) / 2);
      assert.ok(between > stored && between < clear.clearedAt);
      fake.list = { status: 200, body: listBody(between, [A, B], []) };
      const rr = await sync();
      assert.equal((rr as Row).replaced, true, "比本地新的名单要替换");
      assert.equal(await db.finance2HoldClear.count({ where: { customerMark: A } }) > 0, true, "比核对早的名单不作废核对");
      assert.equal((await dispatch(["ZZF2H00A1"])).status, 200);
      await db.adminLastmileOrder.deleteMany({ where: { companyId: CO } });
      await db.shipment.update({ where: { trackingNo: "ZZF2H00A1" }, data: { currentStatus: "inWarehouseTH" } });
      await new Promise((r) => setTimeout(r, 1100));
      fake.list = { status: 200, body: listBody(new Date(), [A, B], []) }; // 比核对晚 → 核对作废
      await sync();
      assert.equal(await db.finance2HoldClear.count(), 0);
      assert.equal((await dispatch(["ZZF2H00A1"])).status, 409);
    });
    await test("R4 财务说还在扣：继续拦", async () => {
      fake.check = () => null; // 默认都回 blocked:true
      const r = await recheck("ZZF2H00A1");
      assert.equal(r.body.data.blocked, true, r.text);
      assert.match(r.body.data.message, /还在扣货/);
      assert.equal((await dispatch(["ZZF2H00A1"])).status, 409);
    });
    await test("R5 财务 5 秒不回：按本地名单继续拦，写明名单时间；不等太久", async () => {
      fake.check = (mark, wb) => ({ ...checkReply(mark, wb, false), delayMs: 7000 });
      const t0 = Date.now();
      const r = await recheck("ZZF2H00A1");
      const took = Date.now() - t0;
      assert.equal(r.body.data.blocked, true, r.text);
      assert.equal(r.body.data.unreachable, true);
      assert.match(r.body.data.message, /连不上财务系统，按 \d{4}-\d{2}-\d{2} \d{2}:\d{2}（泰国时间）的名单继续拦/);
      assert.ok(took < 6500, `等了 ${took} 毫秒`);
      assert.equal((await dispatch(["ZZF2H00A1"])).status, 409);
    });
    await test("R6 财务回 500 / 回的格式不对（blocked 是字符串）/ 回的是别的唛头：都按连不上处理，继续拦", async () => {
      for (const bad of [
        (m: string, w: string | null): FakeReply => ({ status: 500, body: {} }),
        (m: string, w: string | null): FakeReply => ({ status: 200, body: { customerMark: m, waybillNo: w, blocked: "false" } }),
        (_m: string, w: string | null): FakeReply => checkReply("别的唛头", w, false),
      ]) {
        fake.check = bad;
        const r = await recheck("ZZF2H00A1");
        assert.equal(r.body.data.blocked, true, r.text);
        assert.equal(r.body.data.unreachable, true, r.text);
      }
      assert.equal((await dispatch(["ZZF2H00A1"])).status, 409);
    });
    await test("R7 不在名单上的票点核对：也真去问财务（Codex 审查第 5 条）；财务说不扣 → 能放", async () => {
      fake.check = (mark, wb) => checkReply(mark, wb, false);
      const before = fake.requests.length;
      const r = await recheck("ZZF2H00C1");
      assert.equal(r.body.data.blocked, false, r.text);
      assert.equal(fake.requests.length, before + 1);
      assert.equal(fake.requests.at(-1)!.query.get("customerMark"), C);
    });
    await test("R7b 名单上还没有、财务刚把这家加上：核对说扣 → 这家马上开始拦（不等 15 分钟）", async () => {
      fake.check = () => null; // 都回「扣」
      const r = await recheck("ZZF2H00C1");
      assert.equal(r.body.data.blocked, true, r.text);
      assert.equal((await dispatch(["ZZF2H00C1"])).status, 409);
    });
    await test("R7c 晚到的旧答案盖不掉新答案（Codex 审查第 2 条）：先记了 10:00:05 的「扣」，再来一个 10:00:01 的「放」→ 照拦", async () => {
      const t = new Date();
      fake.check = (mark, wb) => checkReply(mark, wb, true, t);
      assert.equal((await recheck("ZZF2H00C1")).body.data.blocked, true);
      fake.check = (mark, wb) => checkReply(mark, wb, false, new Date(t.getTime() - 4000));
      const late = await recheck("ZZF2H00C1");
      assert.equal(late.body.data.blocked, true, `旧的「放」不许盖掉新的「扣」：${late.text}`);
      assert.equal((await dispatch(["ZZF2H00C1"])).status, 409);
      fake.check = (mark, wb) => checkReply(mark, wb, false, new Date(t.getTime() + 1000));
      assert.equal((await recheck("ZZF2H00C1")).body.data.blocked, false, "更新的「放」才算");
    });
    await test("R7d 核对时间不可靠的回话（没带时区 / 只问唛头却回了运单号）当问不到，什么都不记", async () => {
      const n = await db.finance2HoldClear.count();
      fake.check = (mark, wb) => ({ status: 200, body: { customerMark: mark, waybillNo: wb, blocked: false, checkedAt: "2026-12-05T10:21:40", serverTime: "2026-12-05T10:21:40" } });
      assert.equal((await recheck("ZZF2H00A1")).body.data.unreachable, true);
      fake.check = (mark, _wb) => checkReply(mark, "ZZF2H00A1", false);
      assert.equal((await recheck("ZZF2H00A1")).body.data.unreachable, true);
      assert.equal(await db.finance2HoldClear.count(), n);
    });
    await test("R8 别的公司的真运单号：404（第 27 条：造另一家的数据实测）；不存在的号 404；客户号不能用这几个接口", async () => {
      const OTHER = "zz_f2h_other_co";
      await db.order.create({ data: { id: `${P}o_other`, companyId: OTHER, clientId: A, warehouseId: "wh", orderNo: "ZZF2HOTHER", itemName: "别家货", productQuantity: 1, packageCount: 1, packageUnit: "箱", transportMode: "sea", receiverNameTh: "x", receiverPhoneTh: "x", receiverAddressTh: "x", approvalStatus: "approved" } });
      await db.shipment.create({ data: { id: `${P}s_other`, companyId: OTHER, orderId: `${P}o_other`, trackingNo: "ZZF2HOTHER1", currentStatus: "inWarehouseTH", warehouseId: "wh" } });
      try {
        const r = await recheck("ZZF2HOTHER1");
        assert.equal(r.status, 404, r.text);
      } finally {
        await db.shipment.delete({ where: { id: `${P}s_other` } });
        await db.order.delete({ where: { id: `${P}o_other` } });
      }
      assert.equal((await recheck("不存在的号ZZ")).status, 404);
      const c = await call("GET", "/admin/finance2-holds/status", CLIENT_OK, "client");
      assert.equal(c.status, 403);
      const c2 = await call("POST", "/admin/finance2-holds/recheck", CLIENT_OK, "client", { trackingNo: "ZZF2H00A1" });
      assert.equal(c2.status, 403);
    });

    console.log("\n【连不上财务 / 名单出问题】");
    await fresh();
    await sync();
    await test("E1 取名单 500：保留上一份照拦；记失败原因和时间；状态接口说最近没连上", async () => {
      fake.list = { status: 500, body: {} };
      const r = await sync();
      assert.equal(r.kind, "failed");
      assert.equal(await db.finance2Hold.count(), 2);
      assert.equal((await dispatch(["ZZF2H00A1"])).status, 409);
      const st = await db.finance2HoldState.findUnique({ where: { id: "current" } });
      assert.match(st.lastError, /HTTP 500/);
      assert.equal((await logs("fetch_fail")).length, 1);
      assert.ok(st.failingSince, "记下连续失败的起点");
      const s = await staff("GET", "/admin/finance2-holds/status");
      assert.ok(s.body.data.lastErrorLabel);
      assert.ok(s.body.data.listLabel);
    });
    await test("E1b 连续 1 小时取不到打 error 报警（从来没取到过也算；Codex 审查第 9 条）；取到一次就清掉起点", async () => {
      await db.finance2HoldState.update({ where: { id: "current" }, data: { failingSince: ago(2) } });
      const mark = captured.length;
      await sync();
      assert.ok(captured.slice(mark).some((l) => l.includes("[ERROR]") && l.includes("扣货名单取不到了")));
      fake.list = { status: 200, body: listBody(new Date(), [A, B], []) };
      await sync();
      assert.equal((await db.finance2HoldState.findUnique({ where: { id: "current" } })).failingSince, null);
      // 从来没取到过：起点也照记
      await db.finance2HoldState.deleteMany({});
      fake.list = { status: 500, body: {} };
      await sync();
      assert.ok((await db.finance2HoldState.findUnique({ where: { id: "current" } })).failingSince);
      fake.list = { status: 200, body: listBody(new Date(), [A, B], []) };
      await sync();
    });
    await test("E2 5xx 会重试（照约定等几次）；401 不重试", async () => {
      fake.requests = [];
      fake.list = { status: 503, body: {} };
      await syncHoldList({ retryDelaysMs: [10, 10] });
      assert.equal(fake.requests.length, 3);
      fake.requests = [];
      process.env.FINANCE2_HOLDS_SECRET = SECRET.replace("a", "b");
      const r = await syncHoldList({ retryDelaysMs: [10, 10] });
      process.env.FINANCE2_HOLDS_SECRET = SECRET;
      assert.equal(fake.requests.length, 1);
      assert.equal(r.kind, "failed");
      assert.match((r as Row).reason, /401/);
    });
    await test("E3 格式不对的名单整份不收（时间不带时区 / 唛头是数字 / holds 不是数组 / 不是 JSON），上一份留着", async () => {
      const good = listBody(new Date(), [C], []) as Row;
      for (const body of [
        { ...good, generatedAt: "2026-12-05T10:15:00" },
        { ...good, holds: [{ customerMark: 10086, heldSince: "2026-12-03T00:00:00+07:00" }] },
        { ...good, holds: null },
        { ...good, releasedWaybills: [{ waybillNo: "X", customerMark: "Y", releasedAt: "昨天" }] },
      ]) {
        fake.list = { status: 200, body };
        assert.equal((await sync()).kind, "failed");
      }
      fake.list = { status: 200, raw: "<html>gateway</html>" };
      assert.equal((await sync()).kind, "failed");
      assert.deepEqual((await db.finance2Hold.findMany({ orderBy: { customerMark: "asc" } })).map((h: Row) => h.customerMark), [A, B]);
    });
    await test("E4 名单 10 秒不回：这一轮放弃，上一份留着", async () => {
      fake.list = { status: 200, body: listBody(new Date(), [C], []), delayMs: 11_000 };
      const t0 = Date.now();
      const r = await sync();
      assert.equal(r.kind, "failed");
      assert.match((r as Row).reason, /超时/);
      assert.ok(Date.now() - t0 < 10_900);
      assert.equal(await db.finance2Hold.count(), 2);
    });
    await test("E5 整份替换：新名单里没了 A，A 不再拦；晚到的旧名单不盖新的", async () => {
      fake.list = { status: 200, body: listBody(new Date(), [B], []) };
      assert.equal((await sync()).kind, "ok");
      assert.equal((await dispatch(["ZZF2H00A1"])).status, 200);
      fake.list = { status: 200, body: listBody(ago(3), [A, B, C], []) };
      const r = await sync();
      assert.equal(r.kind, "ok");
      assert.equal((r as Row).replaced, false);
      assert.deepEqual((await db.finance2Hold.findMany()).map((h: Row) => h.customerMark), [B]);
      // 名单时间往回跳：不能看着正常 —— 记成失败，页面上能看到「最近没取到」
      const st = await db.finance2HoldState.findUnique({ where: { id: "current" } });
      assert.match(st.lastError, /比本地的还旧/);
      assert.ok(captured.some((l) => l.includes("拿到的比本地的还旧")));
    });
    await test("E6 名单超过 1 天没更新：照拦，另外提示（状态接口、柜子推进回的话）", async () => {
      await fresh();
      fake.list = { status: 200, body: listBody(ago(25), [A], []) };
      await sync();
      const s = await staff("GET", "/admin/finance2-holds/status");
      assert.match(s.body.data.notice, /扣货名单超过 1 天没更新了/);
      const r = await pushWh();
      assert.match(r.body.data.holdNotice, /超过 1 天没更新/);
      assert.equal(await statusOf("ZZF2H00A1"), "inWarehouseTH");
      assert.equal((await dispatch(["ZZF2H00A1"])).status, 409);
    });
    await test("E7 「立即更新名单」只给管理员；员工 403", async () => {
      fake.list = { status: 200, body: listBody(new Date(), [B], []) };
      assert.equal((await staff("POST", "/admin/finance2-holds/refresh")).status, 403);
      const r = await admin("POST", "/admin/finance2-holds/refresh");
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.data.holds, 1);
    });

    console.log("\n【开关】");
    await test("S1 observe（试运行）：名单上的照放，只记「本来会拦」；状态接口照出", async () => {
      await fresh("observe");
      await sync();
      const r = await dispatch(["ZZF2H00A1"]);
      assert.equal(r.status, 200, r.text);
      const p = await pushWh();
      assert.deepEqual(p.body.data.heldShipments, []);
      assert.equal(await statusOf("ZZF2H00A2-1"), "deliveryBooked");
      const obs = await logs("observe");
      assert.ok(obs.some((l: Row) => l.trackingNo === "ZZF2H00A1"));
      assert.equal((await logs("block")).length, 0);
      const s = await staff("GET", "/admin/finance2-holds/status");
      assert.equal(s.body.data.mode, "observe");
    });
    await test("S2 off（默认）：不取名单、不拦、不提示、不记日志；状态接口只回 off", async () => {
      await fresh("enforce");
      await sync();
      process.env.FINANCE2_HOLDS_MODE = "off";
      fake.requests = [];
      assert.equal((await sync()).kind, "off");
      assert.equal(fake.requests.length, 0);
      const r = await dispatch(["ZZF2H00A1"]);
      assert.equal(r.status, 200, r.text);
      const p = await pushWh();
      assert.equal(p.body.data.holdNotice, null);
      const s = await staff("GET", "/admin/finance2-holds/status");
      assert.deepEqual(s.body.data, { mode: "off" });
      assert.equal((await logs("block")).length + (await logs("observe")).length, 0);
      // 开关不填（老板 2026-11-19 答「放货拦截 4」）：配了地址 / 密钥 = observe（去取名单、只记不拦）；都没配才是 off
      delete process.env.FINANCE2_HOLDS_MODE;
      fake.requests = [];
      assert.equal((await sync()).kind, "ok", "没填、配了地址密钥 = observe，照样取名单");
      assert.equal(fake.requests.length, 1);
      assert.equal((await staff("GET", "/admin/finance2-holds/status")).body.data.mode, "observe");
      await db.adminLastmileOrder.deleteMany({ where: { companyId: CO } });
      await db.shipment.update({ where: { trackingNo: "ZZF2H00A2-1" }, data: { currentStatus: "inWarehouseTH" } });
      assert.equal((await dispatch(["ZZF2H00A2-1"])).status, 200, "observe 不拦");
      assert.ok((await logs("observe")).some((l: Row) => l.trackingNo === "ZZF2H00A2-1"), "只记一笔");
      const keep = { s: process.env.FINANCE2_HOLDS_SECRET, b: process.env.FINANCE2_API_BASE };
      process.env.FINANCE2_HOLDS_SECRET = "";
      process.env.FINANCE2_API_BASE = "";
      try {
        fake.requests = [];
        assert.equal((await sync()).kind, "off", "没填、地址密钥也都没配 = off");
        assert.equal(fake.requests.length, 0);
        assert.deepEqual((await staff("GET", "/admin/finance2-holds/status")).body.data, { mode: "off" });
      } finally {
        process.env.FINANCE2_HOLDS_SECRET = keep.s;
        process.env.FINANCE2_API_BASE = keep.b;
        process.env.FINANCE2_HOLDS_MODE = "enforce";
      }
    });
    await test("S3 开了但配错（密钥太短 / 地址错）：照本地名单拦（Codex 审查第 1 条）；页面和回话提示配置有问题；不去连财务；核对答「问不了」", async () => {
      await fresh("enforce");
      await sync();
      for (const [k, v] of [["FINANCE2_HOLDS_SECRET", "short"], ["FINANCE2_API_BASE", "http://10.0.0.5:1"]] as const) {
        const keep = process.env[k];
        process.env[k] = v;
        try {
          const r = await dispatch(["ZZF2H00A1"]);
          assert.equal(r.status, 409, `配错不许变成全放：${r.text}`);
          const ok = await dispatch(["ZZF2H00C1"]);
          assert.equal(ok.status, 200, ok.text);
          assert.match(ok.body.data.holdNotice ?? "", /配置有问题/);
          await db.adminLastmileOrder.deleteMany({ where: { companyId: CO } });
          await db.shipment.update({ where: { trackingNo: "ZZF2H00C1" }, data: { currentStatus: "inWarehouseTH" } });
          const s = await staff("GET", "/admin/finance2-holds/status");
          assert.equal(s.body.data.mode, "enforce");
          assert.match(s.body.data.notice ?? "", /配置有问题/);
          fake.requests = [];
          const sy = await sync();
          assert.equal(sy.kind, "failed");
          assert.equal(fake.requests.length, 0);
          const rc = await recheck("ZZF2H00A1");
          assert.equal(rc.body.data.blocked, true);
          assert.equal(rc.body.data.unreachable, true);
        } finally {
          process.env[k] = keep;
        }
      }
      assert.ok(!captured.join("\n").includes(SECRET));
    });
    await test("S4 开关写了不认识的词：按 enforce 拦", async () => {
      await fresh("enforce");
      await sync();
      process.env.FINANCE2_HOLDS_MODE = "on";
      try {
        assert.equal((await dispatch(["ZZF2H00A1"])).status, 409);
      } finally {
        process.env.FINANCE2_HOLDS_MODE = "enforce";
      }
    });

    console.log("\n【拆派仓回传派送中 —— 照收、记一笔、报给财务（老板 2026-11-19 答「放货拦截 2」；约定 11.1）】");
    const zonedOk = (v: unknown) => typeof v === "string" && /(Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
    const chaipaiRows = async () => { await flushHoldLogs(); return db.finance2HoldLog.findMany({ where: { kind: "chaipai" }, orderBy: { createdAt: "asc" } }); };
    await test("K1 名单上的货被拆派仓派出去了：记一条 chaipai 日志 + 警告，马上报给财务（请求体、请求头照约定 11.1），记成 sent；不在名单上的不记不报", async () => {
      await fresh();
      await sync();
      const gen = (await db.finance2HoldState.findUnique({ where: { id: "current" } })).generatedAt as Date;
      await noteChaipaiRelease(`${P}s_a2c`);
      const k = await chaipaiRows();
      assert.equal(k.length, 1);
      assert.equal(k[0].trackingNo, "ZZF2H00A2-1");
      assert.ok(captured.some((l) => l.includes("扣货名单上的货被拆派仓派出去了")));
      assert.equal(fake.posts.length, 1);
      const post = fake.posts[0];
      assert.equal(post.auth, `Bearer ${SECRET}`);
      assert.match(post.contentType ?? "", /^application\/json/);
      assert.deepEqual(post.body, {
        kind: "releasedWhileHeld",
        occurredAt: k[0].createdAt.toISOString(),
        customerMark: A,
        waybillNo: "ZZF2H00A2",
        trackingNo: "ZZF2H00A2-1",
        entry: "拆派仓回传派送中",
        listGeneratedAt: gen.toISOString(),
      });
      assert.ok(!JSON.stringify(post.body).includes(NAME_A), "不带客户名字");
      assert.equal(k[0].reportStatus, "sent");
      assert.ok(k[0].reportedAt);
      assert.equal(k[0].reportError, null);
      await noteChaipaiRelease(`${P}s_c1`);
      assert.equal((await chaipaiRows()).length, 1, "不在名单上的不记");
      assert.equal(fake.posts.length, 1, "不在名单上的不报");
      // 15 分钟那一轮：报成了的不再报
      await runHoldRound();
      assert.equal(fake.posts.length, 1);
    });
    await test("K2 报不进去（500 / 超时 / 连不上）不丢：留着 pending + 原因；下一轮（runHoldRound，定时任务那一轮）接着报，200 后记 sent、不再报", async () => {
      await fresh();
      await sync();
      fake.events = { status: 500, body: {} };
      await noteChaipaiRelease(`${P}s_a1`);
      let [row] = await chaipaiRows();
      assert.equal(row.reportStatus, "pending");
      assert.match(row.reportError, /HTTP 500/);
      assert.equal(row.reportedAt, null);
      // 下一轮还连不上：照样留着
      fake.events = { status: 503, body: {} };
      const r1 = await runHoldRound();
      assert.equal(r1.sync.kind, "ok", "补报不影响取名单");
      assert.deepEqual(r1.reports, { kind: "done", tried: 1, sent: 0, rejected: 0, pending: 1 });
      [row] = await chaipaiRows();
      assert.equal(row.reportStatus, "pending");
      assert.match(row.reportError, /HTTP 503/);
      // 财务恢复了：这一轮补报成功
      fake.events = { status: 200, body: { serverTime: bkk(new Date()), accepted: true } };
      const before = fake.posts.length;
      const r2 = await runHoldRound();
      assert.deepEqual(r2.reports, { kind: "done", tried: 1, sent: 1, rejected: 0, pending: 0 });
      assert.equal(fake.posts.length, before + 1);
      assert.equal(fake.posts.at(-1)!.body.trackingNo, "ZZF2H00A1");
      [row] = await chaipaiRows();
      assert.equal(row.reportStatus, "sent");
      assert.equal(row.reportError, null);
      await runHoldRound();
      assert.equal(fake.posts.length, before + 1, "报成了不再报");
    });
    await test("K2b 名单取不到的那一轮也照样补报（两件事互不影响）；连不上时一轮里碰到第一条连不上就停，不一条条等超时", async () => {
      await fresh();
      await sync();
      fake.events = { status: 502, body: {} };
      await noteChaipaiRelease(`${P}s_a1`);
      await noteChaipaiRelease(`${P}s_b2`);
      const before = fake.posts.length;
      const r1 = await runHoldRound();
      assert.deepEqual(r1.reports, { kind: "done", tried: 1, sent: 0, rejected: 0, pending: 1 }, "第一条连不上就停");
      assert.equal(fake.posts.length, before + 1);
      fake.list = { status: 500, body: {} };
      fake.events = { status: 200, body: { serverTime: bkk(new Date()), accepted: true } };
      const r2 = await runHoldRound({ retryDelaysMs: [] });
      assert.equal(r2.sync.kind, "failed");
      assert.deepEqual(r2.reports, { kind: "done", tried: 2, sent: 2, rejected: 0, pending: 0 });
      assert.ok((await chaipaiRows()).every((l: Row) => l.reportStatus === "sent"));
    });
    await test("K3 财务回 4xx（400 / 401）：记 rejected、打 error 日志，以后不再报这一条", async () => {
      await fresh();
      await sync();
      fake.events = { status: 400, body: { error: "bad_request", message: "customerMark 1～64 字" } };
      const mark = captured.length;
      await noteChaipaiRelease(`${P}s_a1`);
      const [row] = await chaipaiRows();
      assert.equal(row.reportStatus, "rejected");
      assert.ok(row.reportedAt);
      assert.match(row.reportError, /HTTP 400：customerMark 1～64 字/);
      assert.ok(captured.slice(mark).some((l) => l.includes("[ERROR]") && l.includes("不再报")));
      fake.events = { status: 200, body: { serverTime: bkk(new Date()), accepted: true } };
      const before = fake.posts.length;
      const r = await runHoldRound();
      assert.deepEqual(r.reports, { kind: "done", tried: 0, sent: 0, rejected: 0, pending: 0 });
      assert.equal(fake.posts.length, before);
    });
    await test("K4 observe（试运行）也报：货确实出去了", async () => {
      await fresh("observe");
      await sync();
      await noteChaipaiRelease(`${P}s_a1`);
      const [row] = await chaipaiRows();
      assert.equal(row.reportStatus, "sent");
      assert.equal(fake.posts.length, 1);
      assert.equal(fake.posts[0].body.kind, "releasedWhileHeld");
    });
    await test("K5 开关 off：不记不报；off 时 15 分钟那一轮也不补报以前没报成的", async () => {
      await fresh();
      await sync();
      fake.events = { status: 500, body: {} };
      await noteChaipaiRelease(`${P}s_a1`);
      assert.equal((await chaipaiRows())[0].reportStatus, "pending");
      process.env.FINANCE2_HOLDS_MODE = "off";
      try {
        fake.events = { status: 200, body: {} };
        const before = fake.posts.length;
        await noteChaipaiRelease(`${P}s_b2`);
        assert.equal((await chaipaiRows()).length, 1, "off 不记");
        const r = await retryPendingReports();
        assert.deepEqual(r, { kind: "off" });
        assert.equal(fake.posts.length, before, "off 一条都不报");
      } finally {
        process.env.FINANCE2_HOLDS_MODE = "enforce";
      }
    });
    await test("K6 只补报最近 7 天的（更早的留着不动）；连财务的配置有问题时报不了、留着 pending，配好以后补报", async () => {
      await fresh();
      await sync();
      fake.events = { status: 500, body: {} };
      await noteChaipaiRelease(`${P}s_a1`);
      const [old] = await chaipaiRows();
      await db.finance2HoldLog.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - REPORT_RETRY_WINDOW_MS - 60_000) } });
      fake.events = { status: 200, body: {} };
      const before = fake.posts.length;
      assert.deepEqual(await retryPendingReports(), { kind: "done", tried: 0, sent: 0, rejected: 0, pending: 0 });
      assert.equal(fake.posts.length, before);
      const keep = process.env.FINANCE2_HOLDS_SECRET;
      process.env.FINANCE2_HOLDS_SECRET = "short";
      try {
        await noteChaipaiRelease(`${P}s_b2`);
        const b2 = (await chaipaiRows()).find((l: Row) => l.trackingNo === "ZZF2H00B2");
        assert.equal(b2.reportStatus, "pending", "配置有问题：先记着");
        assert.equal(fake.posts.length, before, "没法报就不发");
        assert.deepEqual(await retryPendingReports(), { kind: "noRemote" });
      } finally {
        process.env.FINANCE2_HOLDS_SECRET = keep;
      }
      const r = await retryPendingReports();
      assert.deepEqual(r, { kind: "done", tried: 1, sent: 1, rejected: 0, pending: 0 });
      assert.equal(fake.posts.at(-1)!.body.trackingNo, "ZZF2H00B2");
    });

    console.log("\n【拿不到扣货名单 → 报给财务（老板 2026-11-19 答「放货拦截 6」；约定 11.2）】");
    const eventsOf = (kind: string) => fake.posts.filter((p) => p.body.kind === kind);
    await test("A1 取名单 401：打 error 日志，同时报 holdListUnavailable（reason 不带密钥、带连续失败起点和上次取到的时间）；一轮只报一次，下一轮还失败不再报", async () => {
      await fresh();
      await sync();
      const fetchedAt = (await db.finance2HoldState.findUnique({ where: { id: "current" } })).fetchedAt as Date;
      fake.list = { status: 401, body: { error: "unauthorized" } };
      await syncHoldList({ retryDelaysMs: [10, 10] });
      const un = eventsOf("holdListUnavailable");
      assert.equal(un.length, 1);
      assert.equal(un[0].auth, `Bearer ${SECRET}`);
      assert.match(un[0].body.reason, /HTTP 401/);
      assert.ok(!JSON.stringify(un[0].body).includes(SECRET));
      const st = await db.finance2HoldState.findUnique({ where: { id: "current" } });
      assert.equal(un[0].body.failingSince, st.failingSince.toISOString());
      assert.equal(un[0].body.lastFetchedAt, fetchedAt.toISOString());
      assert.ok(zonedOk(un[0].body.occurredAt));
      assert.deepEqual(Object.keys(un[0].body).sort(), ["failingSince", "kind", "lastFetchedAt", "occurredAt", "reason"]);
      assert.equal(st.unavailableReport, "sent");
      await sync();
      await sync();
      assert.equal(eventsOf("holdListUnavailable").length, 1, "报成了，这一串失败里不再报");
      assert.equal(eventsOf("holdListRecovered").length, 0);
    });
    await test("A2 又取到了：报一次 holdListRecovered（字段只有 kind、occurredAt），清掉记号；再取到不再报", async () => {
      fake.list = { status: 200, body: listBody(new Date(), [A, B], []) };
      await sync();
      const rec = eventsOf("holdListRecovered");
      assert.equal(rec.length, 1);
      assert.deepEqual(Object.keys(rec[0].body).sort(), ["kind", "occurredAt"]);
      assert.equal((await db.finance2HoldState.findUnique({ where: { id: "current" } })).unavailableReport, null);
      await sync();
      assert.equal(eventsOf("holdListRecovered").length, 1);
    });
    await test("A3 连续 1 小时取不到（5xx）也报；报不进去（503）留着 pending，下一轮失败时再报；从来没报过的不报「恢复了」", async () => {
      await fresh();
      await sync();
      fake.list = { status: 500, body: {} };
      await sync();
      assert.equal(eventsOf("holdListUnavailable").length, 0, "刚开始失败、还不到 1 小时：只打 warn，不报");
      await db.finance2HoldState.update({ where: { id: "current" }, data: { failingSince: ago(2) } });
      fake.events = { status: 503, body: {} };
      await syncHoldList({ retryDelaysMs: [10, 10] });
      assert.equal(eventsOf("holdListUnavailable").length, 1, "一轮（带重试）里只报一次");
      assert.equal((await db.finance2HoldState.findUnique({ where: { id: "current" } })).unavailableReport, "pending");
      fake.events = { status: 200, body: { serverTime: bkk(new Date()), accepted: true } };
      await sync();
      assert.equal(eventsOf("holdListUnavailable").length, 2, "上一轮没报进去，这一轮再报");
      assert.equal((await db.finance2HoldState.findUnique({ where: { id: "current" } })).unavailableReport, "sent");
      fake.list = { status: 200, body: listBody(new Date(), [A, B], []) };
      await sync();
      assert.equal(eventsOf("holdListRecovered").length, 1);
      // 没报过：普通的一次失败后取到，不报「恢复了」
      fake.list = { status: 500, body: {} };
      await sync();
      fake.list = { status: 200, body: listBody(new Date(), [A, B], []) };
      await sync();
      assert.equal(eventsOf("holdListRecovered").length, 1);
      assert.equal(eventsOf("holdListUnavailable").length, 2);
    });
    await test("A4 财务拒收（4xx）「拿不到名单」：打 error、这一串失败里不再报；恢复时也不报「恢复了」", async () => {
      await fresh();
      await sync();
      fake.list = { status: 403, body: {} };
      fake.events = { status: 400, body: { error: "bad_request", message: "reason 太长" } };
      const mark = captured.length;
      await sync();
      assert.equal(eventsOf("holdListUnavailable").length, 1);
      assert.equal((await db.finance2HoldState.findUnique({ where: { id: "current" } })).unavailableReport, "rejected");
      assert.ok(captured.slice(mark).some((l) => l.includes("[ERROR]") && l.includes("不收「拿不到扣货名单」")));
      await sync();
      assert.equal(eventsOf("holdListUnavailable").length, 1);
      fake.events = { status: 200, body: {} };
      fake.list = { status: 200, body: listBody(new Date(), [A, B], []) };
      await sync();
      assert.equal(eventsOf("holdListRecovered").length, 0);
      assert.equal((await db.finance2HoldState.findUnique({ where: { id: "current" } })).unavailableReport, null);
    });
    await test("A5 配置有问题（没有 remote）：只打 error 日志、报不了；报的失败（连不上）不影响取名单的结果", async () => {
      await fresh();
      await sync();
      const keep = process.env.FINANCE2_API_BASE;
      process.env.FINANCE2_API_BASE = "http://10.0.0.5:1";
      try {
        const r = await sync();
        assert.equal(r.kind, "failed");
        assert.equal(fake.posts.length, 0);
      } finally {
        process.env.FINANCE2_API_BASE = keep;
      }
      // 名单能取到、上报连不上（财务那边 hold-events 超时）：名单照样替换成功
      await db.finance2HoldState.update({ where: { id: "current" }, data: { unavailableReport: "sent" } });
      fake.events = { status: 200, body: {}, delayMs: 11_000 };
      fake.list = { status: 200, body: listBody(new Date(), [C], []) };
      const r = await sync();
      assert.equal(r.kind, "ok");
      assert.deepEqual((await db.finance2Hold.findMany()).map((h: Row) => h.customerMark), [C]);
      assert.equal((await db.finance2HoldState.findUnique({ where: { id: "current" } })).unavailableReport, "sent", "恢复没报进去，留着下次再报");
      fake.events = { status: 200, body: {} };
    });
    await test("A6 开关 off：取名单都不做，也什么都不报", async () => {
      await fresh();
      process.env.FINANCE2_HOLDS_MODE = "off";
      try {
        fake.list = { status: 401, body: {} };
        await sync();
        await runHoldRound();
        assert.equal(fake.posts.length, 0);
      } finally {
        process.env.FINANCE2_HOLDS_MODE = "enforce";
      }
    });

    console.log("\n【试运行记录（老板 2026-11-19 答「放货拦截 4」）】");
    await test("O1 管理员看最近 7 天 observe 记录：唛头、运单号、母运单号、入口、几点、按几点的名单；不带金额 / 客户名字 / 操作人；更早的不列", async () => {
      await fresh("observe");
      await sync();
      assert.equal((await dispatch(["ZZF2H00A2-1"])).status, 200);
      assert.equal((await pushWh()).status, 200);
      await flushHoldLogs();
      const old = await db.finance2HoldLog.create({ data: { kind: "observe", result: "试运行：本来会拦，没拦", customerMark: A, trackingNo: "ZZF2HOLD8D", waybillNo: "ZZF2HOLD8D", entry: "柜子推进", createdAt: ago(24 * 8) } });
      await db.finance2HoldLog.create({ data: { kind: "block", result: "拦了", customerMark: B, trackingNo: "ZZF2HBLOCK", entry: "尾端派送", operatorId: STAFF } });
      const r = await admin("GET", "/admin/finance2-holds/observe-log");
      assert.equal(r.status, 200, r.text);
      const d = r.body.data;
      assert.equal(d.mode, "observe");
      assert.equal(d.days, 7);
      assert.equal(d.truncated, false);
      const nos = d.rows.map((x: Row) => x.trackingNo);
      assert.ok(nos.includes("ZZF2H00A2-1") && nos.includes("ZZF2H00A1") && nos.includes("ZZF2H00B2"), JSON.stringify(nos));
      assert.ok(!nos.includes(old.trackingNo), "8 天前的不列");
      assert.ok(!nos.includes("ZZF2HBLOCK"), "只列 observe");
      const child = d.rows.find((x: Row) => x.trackingNo === "ZZF2H00A2-1" && x.entry === "尾端派送出车");
      assert.ok(child, JSON.stringify(d.rows));
      assert.equal(child.waybillNo, "ZZF2H00A2");
      assert.equal(child.customerMark, A);
      assert.match(child.listLabel, /^按 \d{4}-\d{2}-\d{2} \d{2}:\d{2}（泰国时间）的名单$/);
      assert.match(child.atLabel, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      assert.deepEqual(Object.keys(child).sort(), ["at", "atLabel", "customerMark", "entry", "id", "listLabel", "trackingNo", "waybillNo"]);
      assert.ok(!r.text.includes(NAME_A) && !r.text.includes(STAFF) && !/28000|金额|operator/.test(r.text), r.text.slice(0, 300));
      // 新的在前
      const ats = d.rows.map((x: Row) => x.at);
      assert.deepEqual([...ats].sort().reverse(), ats);
    });
    await test("O2 只给管理员：员工 403、客户 403；开关 off 回 off、空列表", async () => {
      assert.equal((await staff("GET", "/admin/finance2-holds/observe-log")).status, 403);
      assert.equal((await call("GET", "/admin/finance2-holds/observe-log", CLIENT_OK, "client")).status, 403);
      process.env.FINANCE2_HOLDS_MODE = "off";
      try {
        const r = await admin("GET", "/admin/finance2-holds/observe-log");
        assert.equal(r.status, 200, r.text);
        assert.deepEqual(r.body.data, { mode: "off", days: 7, rows: [], truncated: false });
      } finally {
        process.env.FINANCE2_HOLDS_MODE = "enforce";
      }
    });

    console.log("\n【撤销误签收不拦（老板 2026-11-19 答「放货拦截 3」）】");
    await test("U1 名单上的 A1 签收点错了：管理员撤销误签收照常改回派送中，不拦、不记 block", async () => {
      await fresh();
      await sync();
      await db.shipment.update({ where: { trackingNo: "ZZF2H00A1" }, data: { currentStatus: "delivered" } });
      await db.adminLastmileOrder.create({ data: { id: `${P}lm_sig`, companyId: CO, deliveryNo: "WDZZF2HU1", shipmentId: `${P}s_a1`, carrierName: "自营", driverName: "司机", licensePlate: "", phoneNumber: "", deliveryDate: "", externalTrackingNo: "", status: "SIGNED" } });
      const r = await admin("POST", "/admin/lastmile/unsign", { id: `${P}lm_sig` });
      assert.equal(r.status, 200, r.text);
      assert.equal(await statusOf("ZZF2H00A1"), "outForDelivery");
      assert.equal((await logs("block")).length, 0);
    });

    await test("Z1 日志里没有密钥", async () => {
      assert.ok(!captured.join("\n").includes(SECRET));
    });

    // 迁移文件：要临时建库，只许在本机一次性库上做
    const u = new URL(url);
    if (["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname)) {
      console.log("\n【迁移文件】");
      const runPrisma = (args: string[], dbUrl: string): { code: number; out: string } => {
        try {
          const out = execFileSync("npx", ["prisma", ...args], { cwd: ROOT, env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
          return { code: 0, out };
        } catch (e: any) {
          return { code: typeof e.status === "number" ? e.status : 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
        }
      };
      const tmpName = `zz_mig_f2h_${Date.now().toString(36)}`;
      const tmp = new URL(url);
      tmp.pathname = `/${tmpName}`;
      const tmpUrl = tmp.toString();
      await prisma.$executeRawUnsafe(`CREATE DATABASE "${tmpName}"`);
      const tmpDb = new PrismaClient({ datasources: { db: { url: tmpUrl } } });
      try {
        await test("M1 上线前的库上跑两遍都不报错；跑完跟 schema.prisma 零差异；上线体检一行不报；现有数据一行不动", async () => {
          const push = runPrisma(["db", "push", `--schema=${SCHEMA}`, "--skip-generate"], tmpUrl);
          assert.equal(push.code, 0, `临时库建结构失败：${push.out.slice(-400)}`);
          for (const t of ["finance2_hold_logs", "finance2_hold_clears", "finance2_hold_releases", "finance2_holds", "finance2_hold_state"]) {
            await tmpDb.$executeRawUnsafe(`DROP TABLE "${t}"`);
          }
          await tmpDb.$executeRawUnsafe(`INSERT INTO users (id, company_id, role, name, phone, status, password_hash) VALUES ('ZZM1', 'c_zz', 'client', '测试客户', '000', 'active', 'hash-keep')`);
          for (const n of [1, 2]) {
            const r = runPrisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION], tmpUrl);
            assert.equal(r.code, 0, `第 ${n} 遍失败：${r.out.slice(-400)}`);
          }
          // 上一轮那份迁移已经上过、表里有日志了，再上这一轮加列的迁移（2026-11-19 扣货上报）：两遍都不报错、老日志一行不动
          await tmpDb.$executeRawUnsafe(`INSERT INTO finance2_hold_logs (id, kind, result, customer_mark) VALUES ('ZZM1LOG', 'chaipai', '老日志', 'ZZM1')`);
          await tmpDb.$executeRawUnsafe(`INSERT INTO finance2_hold_state (id, generated_at, updated_at) VALUES ('current', '2026-11-19T00:00:00Z', now())`);
          for (const n of [1, 2]) {
            const r = runPrisma(["db", "execute", `--schema=${SCHEMA}`, "--file", MIGRATION_REPORTS], tmpUrl);
            assert.equal(r.code, 0, `上报那份第 ${n} 遍失败：${r.out.slice(-400)}`);
          }
          const oldLog = await tmpDb.$queryRawUnsafe<Row[]>(`SELECT kind, result, report_status, reported_at, report_error FROM finance2_hold_logs WHERE id = 'ZZM1LOG'`);
          assert.deepEqual(oldLog, [{ kind: "chaipai", result: "老日志", report_status: null, reported_at: null, report_error: null }], "老日志不动、新列空着（不会被当成要补报的）");
          const st = await tmpDb.$queryRawUnsafe<Row[]>(`SELECT unavailable_report FROM finance2_hold_state WHERE id = 'current'`);
          assert.deepEqual(st, [{ unavailable_report: null }]);
          assert.ok(path.basename(path.dirname(MIGRATION_REPORTS)) > path.basename(path.dirname(MIGRATION)), "上报那份要排在后面（prisma 按目录名排）");
          const diff = runPrisma(["migrate", "diff", "--from-url", tmpUrl, "--to-schema-datamodel", SCHEMA, "--script", "--exit-code"], tmpUrl);
          assert.equal(diff.code, 0, `还差这些：\n${diff.out.split("\n").filter((l) => l.trim() && !l.startsWith("--")).slice(0, 12).join("\n")}`);
          const drift = await tmpDb.$queryRawUnsafe<Row[]>(readFileSync(DRIFT, "utf8"));
          assert.equal(drift.length, 0, `上线体检报了：${JSON.stringify(drift).slice(0, 300)}`);
          const rows = await tmpDb.$queryRawUnsafe<Row[]>(`SELECT password_hash, status FROM users WHERE id = 'ZZM1'`);
          assert.deepEqual(rows, [{ password_hash: "hash-keep", status: "active" }]);
        });
      } finally {
        await tmpDb.$disconnect();
        await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${tmpName}" WITH (FORCE)`);
      }
    } else {
      console.log("\n【迁移文件】这一段要临时建库，只在本机一次性库上跑");
    }
  } finally {
    await flushHoldLogs();
    await cleanup();
    const left = await db.user.count({ where: { companyId: CO } }) + await db.finance2HoldLog.count() + await db.finance2Hold.count();
    if (left !== 0) { failures++; console.log(`  ❌ 测试数据没清干净，剩 ${left} 行`); }
    await prisma.$disconnect();
  }

  console.log(`\n通过 ${passes}，失败 ${failures}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
