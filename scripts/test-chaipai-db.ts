/**
 * 对接拆派仓：真 PostgreSQL 整套流程（2026-10-12）。
 *
 * 走真实接口：拆派仓拉清单（GET /integrations/chaipai/v2/container-manifest）、回传状态（POST /integrations/chaipai/v2/events）、
 * 员工看派送照片（/staff/shipments/chaipai-photo[s]），再用客户 / 员工的轨迹弹窗接口（GET /client/shipments/track）和
 * 删轨迹接口核对结果。拆派仓的只读接口用本机 127.0.0.1 上起的假服务代替，不联网。
 *
 * 覆盖修改清单第 5 节：按柜号给清单（多批次、0 件父单不放、空格大小写匹配、整柜 404、密钥错 401、版本时间稳定）、
 * 接收状态（去重、旧事件、往回走、找不到票、先收到已装车）、自动登记尾端派送（同一趟车同一个 WD、签收放最新照片、
 * 拉回仓撤单、接手员工手工单、转交）、照片（翻页、单张、410、客户看不到）。
 *
 * 只连测试库：DATABASE_URL 不带 neon.tech 的不跑（本机一次性库 / IPv4 连测试库时核实后设 AGENT_PORTAL_TEST_ALLOW_DB=1）；
 * 没有 DATABASE_URL（CI 主 job）打印「跳过」。测试数据全在假公司 zz_cp_co 下，开跑前、跑完后都清干净。
 * 用法：npm run test:chaipai-db
 */
process.env.TZ = "UTC";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

type Row = Record<string, any>;
type Auth = { userId: string; companyId: string; role: string; name: string };

const CO = "zz_cp_co";
const P = "zz_cp_";
const STAFF: Auth = { userId: `${P}staff`, companyId: CO, role: "staff", name: "测试员工" };
const ADMIN: Auth = { userId: `${P}admin`, companyId: CO, role: "admin", name: "测试管理员" };
const CLIENT: Auth = { userId: "ZZCPA", companyId: CO, role: "client", name: "测试客户" };
const PULL = "Pu1lSecret-aB3dE5gH7jK9mN1pQ3sT5vX";
const CB = "CbSecret-Zy8Xw6Vu4Ts2Rq0Po8Nm6Lk4Ji2";
const READ = "ReadSecret-Qw9Er7Ty5Ui3Op1As9Df7Gh5J";

let failures = 0;
async function test(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✅ ${label}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ ${label}\n     ${e instanceof Error ? e.message.split("\n").slice(0, 3).join("\n     ") : String(e)}`);
  }
}

/** 假拆派仓只读接口：按运单 id 配好详情和照片 */
interface FakePhoto { id: string; createdAt: string; status?: number; bytes?: Buffer; type?: string }
interface FakeShipment { status?: number; route?: Row | null; handover?: Row | null; photos?: FakePhoto[] }
const fake = new Map<string, FakeShipment>();
const fakeHits: string[] = [];

function startFake(): Promise<Server> {
  const server = createServer((req, res) => {
    fakeHits.push(req.url ?? "");
    if (req.headers.authorization !== `Bearer ${READ}`) { res.statusCode = 401; res.end("{}"); return; }
    const u = new URL(req.url ?? "/", "http://x");
    const m = /^\/integrations\/domestic\/v2\/shipments\/([^/]+)(?:\/photos\/([^/]+))?$/.exec(u.pathname);
    const s = m ? fake.get(decodeURIComponent(m[1])) : undefined;
    if (!m || !s) { res.statusCode = 404; res.end("{}"); return; }
    if (s.status && s.status !== 200) { res.statusCode = s.status; res.end("{}"); return; }
    const photos = [...(s.photos ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1)); // 拆派仓按 id 升序
    if (m[2]) {
      const p = photos.find((x) => x.id === decodeURIComponent(m[2]));
      if (!p) { res.statusCode = 404; res.end("{}"); return; }
      if (p.status && p.status !== 200) { res.statusCode = p.status; res.end("{}"); return; }
      res.setHeader("content-type", p.type ?? "image/jpeg");
      res.end(p.bytes ?? Buffer.from(`JPEG-${p.id}`));
      return;
    }
    const after = u.searchParams.get("afterPhoto");
    const rest = photos.filter((p) => !after || p.id > after);
    const page = rest.slice(0, 20).map((p) => ({ id: p.id, createdAt: p.createdAt }));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ code: "OK", message: "success", data: {
      protocolVersion: 2, route: s.route ?? null, handover: s.handover ?? null,
      photos: { items: page, nextCursor: rest.length > 20 ? page[19].id : null },
    } }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url || url.includes("blocked")) {
    console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测");
    return;
  }
  if (!url.includes("neon.tech") && process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：DATABASE_URL 不是 Neon 测试库，怕连到生产库不跑（确认是测试库可设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = "test";
  const server = await startFake();
  const port = (server.address() as AddressInfo).port;
  const enable = () => Object.assign(process.env, {
    CHAIPAI_ENABLED: "true", CHAIPAI_COMPANY_ID: "xiangtai", CHAIPAI_PULL_SECRET: PULL, CHAIPAI_CALLBACK_SECRET: CB,
    CHAIPAI_READ_SECRET: READ, CHAIPAI_API_BASE: `http://127.0.0.1:${port}`,
  });
  enable();

  const { prisma } = await import("../apps/api/src/db/prisma");
  const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
  const pm: any = prisma;
  const routes = new Map<string, Function>();
  const app: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) app[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
  (await import("../apps/api/src/modules/chaipai/routes")).registerChaipaiRoutes(app);
  (await import("../apps/api/src/modules/containers/routes")).registerContainerRoutes(app);
  (await import("../apps/api/src/modules/shipments/routes")).registerShipmentRoutes(app);

  async function call(key: string, opts: { auth?: Auth; body?: unknown; query?: Record<string, string>; authorization?: string } = {}): Promise<{ status: number; raw: any }> {
    const handler = routes.get(key);
    assert.ok(handler, `没有这个接口：${key}`);
    let status = 200;
    let raw: any;
    const res: any = { requestId: "t", status(s: number) { status = s; return res; }, json(p: any) { raw = p; }, setHeader() {} };
    try {
      await handler!({ body: opts.body, query: opts.query ?? {}, headers: opts.authorization ? { authorization: opts.authorization } : {}, auth: opts.auth }, res);
    } catch (e) {
      if (e instanceof BusinessError) { status = e.httpStatus; raw = { code: e.code, message: e.message }; } else throw e;
    }
    return { status, raw };
  }
  const pull = (containerNo: string, secret = PULL) =>
    call("GET /integrations/chaipai/v2/container-manifest", { query: { containerNo }, authorization: `Bearer ${secret}` });

  let evSeq = 0;
  const seqOf = new Map<string, number>();
  /** 发一条回传；序号默认每票递增 */
  async function send(shipmentId: string, status: string, extra: Row = {}, opts: { seq?: number; eventId?: string; occurredAt?: string } = {}) {
    const seq = opts.seq ?? (seqOf.get(shipmentId) ?? 0) + 1;
    seqOf.set(shipmentId, Math.max(seq, seqOf.get(shipmentId) ?? 0));
    const body = {
      eventId: opts.eventId ?? `${P}ev_${evSeq++}`, waybillNo: "x", status,
      occurredAt: opts.occurredAt ?? new Date(Date.UTC(2026, 9, 12, 3, 0, 0) + evSeq * 60000).toISOString(),
      protocolVersion: 2, companyId: "xiangtai", sourceShipmentId: shipmentId, parentWaybillNo: "x",
      sourceUpdatedAt: "2026-10-12T00:00:00.000Z", sequence: seq, batchKey: "k", batchNo: "b", containerNo: "c", ...extra,
    };
    const r = await call("POST /integrations/chaipai/v2/events", { body, authorization: `Bearer ${CB}` });
    return { ...r, body };
  }
  const shipmentOf = (id: string) => pm.shipment.findUnique({ where: { id }, select: { currentStatus: true, trackingNo: true } });
  const logsOf = (id: string) => pm.statusLog.findMany({ where: { shipmentId: id }, orderBy: [{ changedAt: "asc" }, { id: "asc" }] });
  const rowsOf = (id: string) => pm.adminLastmileOrder.findMany({ where: { shipmentId: id }, orderBy: { updatedAt: "desc" } });

  async function cleanup(): Promise<void> {
    const ships = await pm.shipment.findMany({ where: { companyId: CO }, select: { id: true } });
    const ids = ships.map((s: Row) => s.id);
    await pm.chaipaiCallbackEvent.deleteMany({ where: { OR: [{ companyId: CO }, { shipmentId: { in: ids } }, { eventId: { startsWith: P } }] } });
    await pm.chaipaiManifestVersion.deleteMany({ where: { OR: [{ companyId: CO }, { shipmentId: { in: ids } }] } });
    await pm.chaipaiShipmentState.deleteMany({ where: { companyId: CO } });
    await pm.adminLastmileOrder.deleteMany({ where: { companyId: CO } });
    const containers = await pm.container.findMany({ where: { companyId: CO }, select: { id: true } });
    await pm.shipmentContainerItem.deleteMany({ where: { containerId: { in: containers.map((c: Row) => c.id) } } });
    await pm.container.deleteMany({ where: { companyId: CO } });
    await pm.statusLog.deleteMany({ where: { companyId: CO } });
    await pm.auditLog.deleteMany({ where: { companyId: CO } });
    await pm.shipment.deleteMany({ where: { companyId: CO } });
    await pm.orderProduct.deleteMany({ where: { order: { companyId: CO } } });
    await pm.order.deleteMany({ where: { companyId: CO } });
    await pm.user.deleteMany({ where: { companyId: CO } });
  }

  const stamp = Date.now().toString(36).toUpperCase();
  let n = 0;
  async function seedOrder(clientId: string, pieces: number, weightKg: number): Promise<string> {
    const id = `${P}o_${n++}`;
    await pm.order.create({ data: {
      id, companyId: CO, clientId, warehouseId: `${P}wh`, itemName: "测试鞋", productQuantity: pieces, packageCount: pieces,
      packageUnit: "箱", transportMode: "sea", receiverNameTh: "收货人", receiverPhoneTh: "000", receiverAddressTh: "地址", weightKg,
    } });
    return id;
  }
  async function seedShipment(o: { orderId: string; trackingNo: string; parent?: string | null; pieces: number; status: string; batchNo?: string | null; weightKg?: number | null }): Promise<string> {
    const id = `${P}s_${o.trackingNo}`;
    await pm.shipment.create({ data: {
      id, companyId: CO, orderId: o.orderId, trackingNo: o.trackingNo, parentTrackingNo: o.parent ?? null, currentStatus: o.status,
      warehouseId: `${P}wh`, packageCount: o.pieces, volumeM3: 0.5 * o.pieces, weightKg: o.weightKg === undefined ? 10 * o.pieces : o.weightKg,
      transportMode: "sea", batchNo: o.batchNo ?? null, itemName: "测试鞋",
    } });
    return id;
  }
  async function seedContainer(containerNo: string, isFcl = false): Promise<string> {
    const c = await pm.container.create({ data: { companyId: CO, containerNo, containerType: "40HQ", transportMode: "sea", isFcl, currentStatus: "UNLOADING" } });
    return c.id;
  }
  const load = (containerId: string, shipmentId: string, pieces: number, vol: number) =>
    pm.shipmentContainerItem.create({ data: { containerId, shipmentId, loadedPieceCount: pieces, loadedVolumeM3: vol } });

  console.log("对接拆派仓（真库）");
  try {
    await cleanup();
    for (const u of [STAFF, ADMIN]) await pm.user.create({ data: { id: u.userId, companyId: CO, role: u.role, name: u.name, phone: "000", status: "active" } });
    for (const id of ["ZZCPA", "ZZCPB"]) await pm.user.create({ data: { id, companyId: CO, role: "client", name: `客户${id}`, phone: "000", status: "active" } });

    // ── 一个拼柜：两个批次 + 空批次；一票分柜（0 件父单 + 两张子单）；一票挂两个柜；还有一个整柜 ──
    const ctnNo = `ZZCP${stamp}01`;
    const C1 = await seedContainer(ctnNo);
    const C2 = await seedContainer(`ZZCP${stamp}02`);
    const FCL = await seedContainer(`ZZCPFCL${stamp}`, true);
    const oA = await seedOrder("ZZCPA", 3, 30);
    const S1 = await seedShipment({ orderId: oA, trackingNo: `ZZCPT${stamp}1`, pieces: 3, status: "unloading", batchNo: "B1" });
    await load(C1, S1, 3, 1.5);
    const oP = await seedOrder("ZZCPB", 3, 33);
    const parentNo = `ZZCPT${stamp}2`;
    const PARENT = await seedShipment({ orderId: oP, trackingNo: parentNo, pieces: 0, status: "unloading", batchNo: "B2", weightKg: 0 });
    const K1 = await seedShipment({ orderId: oP, trackingNo: `${parentNo}-1`, parent: parentNo, pieces: 2, status: "unloading", batchNo: "B2", weightKg: 22 });
    const K2 = await seedShipment({ orderId: oP, trackingNo: `${parentNo}-2`, parent: parentNo, pieces: 1, status: "unloading", batchNo: "B2", weightKg: 11 });
    await load(C1, PARENT, 0, 0);
    await load(C1, K1, 2, 1.0);
    await load(C1, K2, 1, 0.5);
    const oN = await seedOrder("ZZCPA", 1, 5);
    const S3 = await seedShipment({ orderId: oN, trackingNo: `ZZCPT${stamp}3`, pieces: 1, status: "customsCleared", batchNo: null });
    await load(C1, S3, 1, 0.25);
    const oM = await seedOrder("ZZCPA", 2, 20);
    const MULTI = await seedShipment({ orderId: oM, trackingNo: `ZZCPT${stamp}4`, pieces: 2, status: "unloading", batchNo: "B1" });
    await load(C1, MULTI, 1, 0.5);
    await load(C2, MULTI, 1, 0.5);
    const oF = await seedOrder("ZZCPA", 1, 5);
    const FS = await seedShipment({ orderId: oF, trackingNo: `ZZCPT${stamp}5`, pieces: 1, status: "unloading" });
    await load(FCL, FS, 1, 1);

    console.log("\n【拉清单】");
    let firstVersions: Record<string, string> = {};
    await test("L1 密钥不对 401；开关关着 503；没这个柜 404；整柜的柜号也 404（第 251 条）", async () => {
      assert.equal((await pull(ctnNo, "wrong-secret-wrong-secret-wrong-secret")).status, 401);
      process.env.CHAIPAI_ENABLED = "false";
      assert.equal((await pull(ctnNo)).status, 503);
      enable();
      assert.equal((await pull("NOSUCH123")).status, 404);
      assert.equal((await pull(`ZZCPFCL${stamp}`)).status, 404);
    });
    await test("L2 柜号去空格、不分大小写也能对上；回裸 JSON（没有 code 外壳）、protocolVersion 2、companyId xiangtai、柜号原文", async () => {
      const spaced = ` ${ctnNo.slice(0, 4).toLowerCase()} ${ctnNo.slice(4)}\u3000`;
      const r = await pull(spaced);
      assert.equal(r.status, 200, JSON.stringify(r.raw).slice(0, 200));
      assert.equal(r.raw.code, undefined);
      assert.equal(r.raw.protocolVersion, 2);
      assert.equal(r.raw.companyId, "xiangtai");
      assert.equal(r.raw.containerNo, ctnNo);
      assert.ok(r.raw.manifests.every((m: Row) => m.containerNo === ctnNo && m.companyId === "xiangtai"));
    });
    await test("L3 按批次分份（B1 / B2 / NO-BATCH）；0 件父单、挂两个柜的票不放；字段：唛头=客户账号、件数方数是本柜的、数字不是字符串", async () => {
      const r = await pull(ctnNo);
      const byBatch = Object.fromEntries(r.raw.manifests.map((m: Row) => [m.batchNo, m.shipments.map((s: Row) => s.sourceShipmentId).sort()]));
      assert.deepEqual(byBatch, { B1: [S1], B2: [K1, K2].sort(), "NO-BATCH": [S3] });
      const all = r.raw.manifests.flatMap((m: Row) => m.shipments);
      const s1 = all.find((s: Row) => s.sourceShipmentId === S1);
      assert.deepEqual(
        [s1.waybillNo, s1.parentWaybillNo, s1.customerCode, s1.boxCount, s1.volumeM3, s1.weightKg, s1.transportMode, s1.itemName],
        [`ZZCPT${stamp}1`, `ZZCPT${stamp}1`, "ZZCPA", 3, 1.5, 30, "海运", "测试鞋"],
      );
      const k1 = all.find((s: Row) => s.sourceShipmentId === K1);
      assert.deepEqual([k1.parentWaybillNo, k1.customerCode, k1.boxCount, k1.weightKg], [parentNo, "ZZCPB", 2, 22]);
      assert.ok(all.every((s: Row) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s.sourceUpdatedAt)));
      assert.ok(all.every((s: Row) => !("remark" in s)), "没备注就不放这个键");
      firstVersions = Object.fromEntries(all.map((s: Row) => [s.sourceShipmentId, s.sourceUpdatedAt]));
    });
    await test("L4 再拉一次版本时间一字不变；改了一票的装柜件数只有那一票版本变大", async () => {
      const again = (await pull(ctnNo)).raw.manifests.flatMap((m: Row) => m.shipments);
      for (const s of again) assert.equal(s.sourceUpdatedAt, firstVersions[s.sourceShipmentId], `${s.sourceShipmentId} 版本变了`);
      await pm.shipmentContainerItem.updateMany({ where: { containerId: C1, shipmentId: S3 }, data: { loadedVolumeM3: 0.3 } });
      const third = (await pull(ctnNo)).raw.manifests.flatMap((m: Row) => m.shipments);
      for (const s of third) {
        if (s.sourceShipmentId === S3) assert.ok(s.sourceUpdatedAt > firstVersions[S3], "内容变了版本要变大");
        else assert.equal(s.sourceUpdatedAt, firstVersions[s.sourceShipmentId]);
      }
    });

    console.log("\n【收回传：状态和轨迹】");
    await test("R1 密钥不对 401；格式不对 400；公司编号不对 409；湘泰没有这票 → IGNORED_OLDER 什么都不写", async () => {
      assert.equal((await call("POST /integrations/chaipai/v2/events", { body: {}, authorization: "Bearer nope" })).status, 401);
      assert.equal((await call("POST /integrations/chaipai/v2/events", { body: { protocolVersion: 2 }, authorization: `Bearer ${CB}` })).status, 400);
      assert.equal((await send(S1, "ARRIVED", { companyId: "other" })).status, 409);
      const r = await send(`${P}nosuch`, "ARRIVED");
      assert.deepEqual([r.status, r.raw], [200, { eventId: r.body.eventId, result: "IGNORED_OLDER" }]);
      assert.equal(await pm.chaipaiCallbackEvent.count({ where: { eventId: r.body.eventId } }), 0);
    });
    await test("R2 ARRIVED：卸柜中 → 已到泰国仓，轨迹「已到泰国仓，实到 3 件」，时间用 occurredAt；记了消息和每票状态；回裸 JSON APPLIED", async () => {
      const r = await send(S1, "ARRIVED", { actualBoxCount: 3, shortage: false });
      assert.deepEqual([r.status, r.raw], [200, { eventId: r.body.eventId, result: "APPLIED" }]);
      assert.equal((await shipmentOf(S1)).currentStatus, "inWarehouseTH");
      const logs = await logsOf(S1);
      const last = logs[logs.length - 1];
      assert.deepEqual([last.id.startsWith("sl_cp_"), last.fromStatus, last.toStatus, last.remark, last.changedAt.toISOString(), last.operatorName],
        [true, "unloading", "inWarehouseTH", "已到泰国仓，实到 3 件", r.body.occurredAt, "拆派仓"]);
      const st = await pm.chaipaiShipmentState.findUnique({ where: { shipmentId: S1 } });
      assert.deepEqual([st.lastSequence, st.thaiStatus, st.actualBoxCount, st.shortage], [r.body.sequence, "ARRIVED", 3, false]);
      assert.equal((await pm.chaipaiCallbackEvent.findUnique({ where: { eventId: r.body.eventId } })).result, "APPLIED");
    });
    await test("R3 同一编号再来 → DUPLICATE 不重复写轨迹；同一编号换了内容 → 409；同时来两遍 → 一个 APPLIED 一个 DUPLICATE", async () => {
      const r = await send(S1, "LOADED");
      const before = (await logsOf(S1)).length;
      const again = await call("POST /integrations/chaipai/v2/events", { body: r.body, authorization: `Bearer ${CB}` });
      assert.deepEqual(again.raw, { eventId: r.body.eventId, result: "DUPLICATE" });
      assert.equal((await logsOf(S1)).length, before);
      const changed = await call("POST /integrations/chaipai/v2/events", { body: { ...r.body, sequence: 99 }, authorization: `Bearer ${CB}` });
      assert.equal(changed.status, 409);
      const body = { ...r.body, eventId: `${P}race`, sequence: (seqOf.get(S1) ?? 0) + 1, status: "ARRIVED" };
      seqOf.set(S1, body.sequence);
      const both = await Promise.all([1, 2].map(() => call("POST /integrations/chaipai/v2/events", { body, authorization: `Bearer ${CB}` })));
      assert.deepEqual(both.map((x) => x.raw.result).sort(), ["APPLIED", "DUPLICATE"]);
    });
    await test("R4 序号旧的 → IGNORED_OLDER：状态不动、不写轨迹，消息照记；跳号（1 之后来 5）照样应用", async () => {
      const before = (await logsOf(S1)).length;
      const old = await send(S1, "OUT_FOR_DELIVERY", {}, { seq: 1 });
      assert.equal(old.raw.result, "IGNORED_OLDER");
      assert.equal((await shipmentOf(S1)).currentStatus, "inWarehouseTH");
      assert.equal((await logsOf(S1)).length, before);
      assert.equal((await pm.chaipaiCallbackEvent.findUnique({ where: { eventId: old.body.eventId } })).result, "IGNORED_OLDER");
      const jump = await send(S1, "LOADED", {}, { seq: 50 });
      assert.equal(jump.raw.result, "APPLIED");
    });
    await test("R5 LOADED：已到泰国仓时状态不动，只写「泰国已装车」；还在清关时先收到 LOADED → 提到已到泰国仓（第 253 条）", async () => {
      const logs = await logsOf(S1);
      assert.deepEqual([logs[logs.length - 1].remark, logs[logs.length - 1].toStatus, (await shipmentOf(S1)).currentStatus],
        ["泰国已装车", "inWarehouseTH", "inWarehouseTH"]);
      const r = await send(S3, "LOADED");
      assert.equal(r.raw.result, "APPLIED");
      const l3 = await logsOf(S3);
      assert.deepEqual([(await shipmentOf(S3)).currentStatus, l3[l3.length - 1].fromStatus, l3[l3.length - 1].remark],
        ["inWarehouseTH", "customsCleared", "泰国已装车"]);
    });

    console.log("\n【派送中 / 已签收：自动登记尾端派送】");
    const routeA = { id: `${P}routeA`, status: "DEPARTED", driverName: "张三", plateNo: "1กข1234", departedAt: "2026-10-11T17:30:00.000Z" };
    let wdA = "";
    await test("D1 派送中：建一张派送中的派送单（自营、司机车牌照填、派送日期按曼谷取出发日、电话空），运单派送中，轨迹「司机【张三】正在为您派送」", async () => {
      fake.set(S1, { route: routeA, handover: null, photos: [] });
      const r = await send(S1, "OUT_FOR_DELIVERY", {}, { seq: 60 });
      assert.equal(r.raw.result, "APPLIED", JSON.stringify(r.raw));
      const rows = await rowsOf(S1);
      assert.equal(rows.length, 1);
      const row = rows[0];
      assert.deepEqual([row.status, row.carrierName, row.driverName, row.licensePlate, row.phoneNumber, row.deliveryDate, row.externalTrackingNo, /^WD\d{6}$/.test(row.deliveryNo)],
        ["DELIVERING", "自营", "张三", "1กข1234", "", "2026-10-12", "", true]);
      wdA = row.deliveryNo;
      assert.equal((await shipmentOf(S1)).currentStatus, "outForDelivery");
      const logs = await logsOf(S1);
      assert.deepEqual([logs[logs.length - 1].id.startsWith("sl_lm_cp_"), logs[logs.length - 1].remark], [true, "司机【张三】正在为您派送，请注意查收"]);
    });
    await test("D2 同一趟车（同一个 route.id）的另一票用同一个 WD 号；另一趟车发新号", async () => {
      await send(K1, "ARRIVED");
      await send(K2, "ARRIVED");
      fake.set(K1, { route: routeA, photos: [] });
      await send(K1, "OUT_FOR_DELIVERY");
      assert.equal((await rowsOf(K1))[0].deliveryNo, wdA);
      fake.set(K2, { route: { ...routeA, id: `${P}routeB`, driverName: "李四", plateNo: "2ขค5678" }, photos: [] });
      await send(K2, "OUT_FOR_DELIVERY");
      const k2 = (await rowsOf(K2))[0];
      assert.notEqual(k2.deliveryNo, wdA);
      assert.equal(k2.driverName, "李四");
    });
    await test("D3 已签收：派送单改已签收，签收图 = 签收前最新一张照片（之后员工补拍的不算）；运单已签收；客户轨迹看得到签收单", async () => {
      fake.set(S1, { route: routeA, photos: [
        { id: "p-c", createdAt: "2026-10-12T02:00:00.000Z" },
        { id: "p-a", createdAt: "2026-10-12T04:00:00.000Z", bytes: Buffer.from("SIGNED-PHOTO") },
        { id: "p-b", createdAt: "2026-10-12T09:00:00.000Z" },
      ] });
      const r = await send(S1, "DELIVERED", {}, { seq: 61, occurredAt: "2026-10-12T04:05:00.000Z" });
      assert.equal(r.raw.result, "APPLIED");
      const row = (await rowsOf(S1))[0];
      assert.deepEqual([row.status, row.deliveryNo, row.signImageBase64], ["SIGNED", wdA, Buffer.from("SIGNED-PHOTO").toString("base64")]);
      assert.equal((await shipmentOf(S1)).currentStatus, "delivered");
      const logs = await logsOf(S1);
      assert.equal(logs[logs.length - 1].remark, `尾程派送已签收（${wdA}）`);
      const track = await call("GET /client/shipments/track", { auth: CLIENT, query: { trackingNo: `ZZCPT${stamp}1` } });
      assert.equal(track.status, 200);
      assert.equal(track.raw.data.lastmile.status, "SIGNED");
      assert.equal(track.raw.data.lastmile.signImageBase64, `data:image/jpeg;base64,${Buffer.from("SIGNED-PHOTO").toString("base64")}`);
      const texts = JSON.stringify(track.raw.data.timeline);
      assert.ok(!texts.includes("拆派仓"), "客户看到了「拆派仓」");
      assert.ok(track.raw.data.timeline.every((t: Row) => !("operatorName" in t)), "客户拿到了操作人");
    });
    await test("D4 父单：两张子单签了一张父单不签；送不成拉回仓（派送中 → 已到仓）撤掉那张派送单、轨迹「未送达，已回泰国仓」；两张都签了父单才签", async () => {
      fake.set(K1, { route: routeA, photos: [{ id: "k1p", createdAt: "2026-10-12T03:00:00.000Z" }] });
      await send(K1, "DELIVERED");
      assert.equal((await shipmentOf(K1)).currentStatus, "delivered");
      assert.notEqual((await shipmentOf(PARENT)).currentStatus, "delivered");
      const back = await send(K2, "ARRIVED");
      assert.equal(back.raw.result, "APPLIED");
      assert.equal((await rowsOf(K2)).length, 0, "拉回仓要撤单");
      assert.equal((await shipmentOf(K2)).currentStatus, "inWarehouseTH");
      const l2 = await logsOf(K2);
      assert.deepEqual([l2[l2.length - 1].id.startsWith("sl_lmdel_cp_"), l2[l2.length - 1].fromStatus, l2[l2.length - 1].remark],
        [true, "outForDelivery", "未送达，已回泰国仓"]);
      fake.set(K2, { route: { ...routeA, id: `${P}routeC` }, photos: [{ id: "k2p", createdAt: "2026-10-12T05:00:00.000Z" }] });
      await send(K2, "OUT_FOR_DELIVERY");
      await send(K2, "DELIVERED", {}, { occurredAt: "2026-10-12T06:00:00.000Z" });
      assert.equal((await shipmentOf(K2)).currentStatus, "delivered");
      assert.equal((await shipmentOf(PARENT)).currentStatus, "delivered");
    });
    await test("D5 拆派仓写的轨迹员工不能单删（第 254 条）：已到仓那条、派送那条都 409", async () => {
      const logs = await logsOf(S1);
      for (const prefix of ["sl_cp_", "sl_lm_cp_"]) {
        const target = logs.find((l: Row) => l.id.startsWith(prefix) && l.toStatus !== "delivered");
        const r = await call("POST /staff/shipments/track/delete-log", { auth: STAFF, body: { logId: target.id } });
        assert.equal(r.status, 409, `${prefix} 竟然能删`);
      }
    });

    console.log("\n【别的情况】");
    await test("X1 员工已经手工登记、还在派送中：不新建，接手那张（员工填的司机不改）；签收也签那张", async () => {
      const oX = await seedOrder("ZZCPA", 1, 5);
      const SX = await seedShipment({ orderId: oX, trackingNo: `ZZCPT${stamp}X`, pieces: 1, status: "outForDelivery" });
      await pm.adminLastmileOrder.create({ data: { id: `${P}lm_manual`, companyId: CO, deliveryNo: "WDZZ0001", shipmentId: SX, carrierName: "自营",
        externalTrackingNo: "", driverName: "员工司机", licensePlate: "X1", phoneNumber: "0991", deliveryDate: "2026-10-12", status: "DELIVERING" } });
      fake.set(SX, { route: routeA, photos: [{ id: "x1", createdAt: "2026-10-12T03:00:00.000Z" }] });
      await send(SX, "OUT_FOR_DELIVERY");
      let rows = await rowsOf(SX);
      assert.deepEqual(rows.map((r: Row) => [r.id, r.driverName, r.status]), [[`${P}lm_manual`, "员工司机", "DELIVERING"]]);
      await send(SX, "DELIVERED");
      rows = await rowsOf(SX);
      assert.deepEqual(rows.map((r: Row) => [r.id, r.status, !!r.signImageBase64]), [[`${P}lm_manual`, "SIGNED", true]]);
    });
    await test("X2 转交给别的物流：承运商写对方物流名、外部单号写对方单号，轨迹「已交给【Kerry】派送，单号 K123」", async () => {
      const oH = await seedOrder("ZZCPA", 1, 5);
      const SH = await seedShipment({ orderId: oH, trackingNo: `ZZCPT${stamp}H`, pieces: 1, status: "inWarehouseTH" });
      fake.set(SH, { route: null, handover: { carrierName: "Kerry", trackingNo: "K123" }, photos: [] });
      await send(SH, "OUT_FOR_DELIVERY", {}, { occurredAt: "2026-10-12T18:00:00.000Z" });
      const row = (await rowsOf(SH))[0];
      assert.deepEqual([row.carrierName, row.externalTrackingNo, row.driverName, row.deliveryDate], ["Kerry", "K123", "", "2026-10-13"]);
      const logs = await logsOf(SH);
      assert.equal(logs[logs.length - 1].remark, "已交给【Kerry】派送，单号 K123，请注意查收");
    });
    await test("X3 只读接口暂时坏了（503）→ 回 503、一个字都不写；修好后重发同一条照常办", async () => {
      const oE = await seedOrder("ZZCPA", 1, 5);
      const SE = await seedShipment({ orderId: oE, trackingNo: `ZZCPT${stamp}E`, pieces: 1, status: "inWarehouseTH" });
      fake.set(SE, { status: 503 });
      const r = await send(SE, "OUT_FOR_DELIVERY");
      assert.equal(r.status, 503);
      assert.deepEqual([(await shipmentOf(SE)).currentStatus, (await rowsOf(SE)).length, await pm.chaipaiCallbackEvent.count({ where: { eventId: r.body.eventId } })],
        ["inWarehouseTH", 0, 0]);
      fake.set(SE, { route: routeA, photos: [] });
      const again = await call("POST /integrations/chaipai/v2/events", { body: r.body, authorization: `Bearer ${CB}` });
      assert.equal(again.raw.result, "APPLIED");
      assert.equal((await rowsOf(SE)).length, 1);
    });
    await test("X4 只读接口说没这票（404）→ 照常登记，司机车牌留空、承运商自营、轨迹不写「司机【】」", async () => {
      const oQ = await seedOrder("ZZCPA", 1, 5);
      const SQ = await seedShipment({ orderId: oQ, trackingNo: `ZZCPT${stamp}Q`, pieces: 1, status: "inWarehouseTH" });
      fake.delete(SQ);
      await send(SQ, "OUT_FOR_DELIVERY");
      const row = (await rowsOf(SQ))[0];
      assert.deepEqual([row.carrierName, row.driverName, row.licensePlate], ["自营", "", ""]);
      const logs = await logsOf(SQ);
      assert.equal(logs[logs.length - 1].remark, `正在为您派送，请注意查收（${row.deliveryNo}）`);
    });
    await test("X5 湘泰员工手工签过、拆派仓又说已到仓：照「撤销误签收」退回再撤单，运单回已到泰国仓（两条轨迹）", async () => {
      const oU = await seedOrder("ZZCPA", 1, 5);
      const SU = await seedShipment({ orderId: oU, trackingNo: `ZZCPT${stamp}U`, pieces: 1, status: "delivered" });
      await pm.adminLastmileOrder.create({ data: { id: `${P}lm_signed`, companyId: CO, deliveryNo: "WDZZ0002", shipmentId: SU, carrierName: "自营",
        externalTrackingNo: "", driverName: "", licensePlate: "", phoneNumber: "", deliveryDate: "2026-10-12", status: "SIGNED", signImageBase64: "AAAA" } });
      await send(SU, "ARRIVED");
      assert.equal((await shipmentOf(SU)).currentStatus, "inWarehouseTH");
      assert.equal((await rowsOf(SU)).length, 0);
      const logs = (await logsOf(SU)).slice(-2);
      assert.deepEqual(logs.map((l: Row) => [l.fromStatus, l.toStatus]), [["delivered", "outForDelivery"], ["outForDelivery", "inWarehouseTH"]]);
      assert.match(logs[0].remark, /^撤销误签收（WDZZ0002）/);
    });
    await test("X6 签收时还没有派送单（派送中那条丢了）：直接建一张已签收的、放签收图", async () => {
      const oV = await seedOrder("ZZCPA", 1, 5);
      const SV = await seedShipment({ orderId: oV, trackingNo: `ZZCPT${stamp}V`, pieces: 1, status: "inWarehouseTH" });
      fake.set(SV, { route: routeA, photos: [{ id: "v1", createdAt: "2026-10-12T03:00:00.000Z", type: "image/png" }] });
      await send(SV, "DELIVERED", {}, { occurredAt: "2026-10-12T05:00:00.000Z" });
      const row = (await rowsOf(SV))[0];
      assert.deepEqual([row.status, row.deliveryNo, !!row.signImageBase64], ["SIGNED", wdA, true]);
      assert.equal((await shipmentOf(SV)).currentStatus, "delivered");
    });

    console.log("\n【派送照片（只给员工）】");
    await test("F1 员工：25 张照片翻两页取全、按拍照时间排；客户调这个接口 403；没经过拆派仓的票是 none；开关关着是 disabled", async () => {
      const photos = Array.from({ length: 25 }, (_, i) => ({ id: `f${String(i).padStart(2, "0")}`, createdAt: new Date(Date.UTC(2026, 9, 12, 0, 59 - i)).toISOString() }));
      fake.set(S1, { route: routeA, photos });
      const r = await call("GET /staff/shipments/chaipai-photos", { auth: STAFF, query: { trackingNo: `ZZCPT${stamp}1` } });
      assert.equal(r.raw.data.state, "ok");
      assert.equal(r.raw.data.items.length, 25);
      assert.equal(r.raw.data.items[0].id, "f24");
      assert.equal((await call("GET /staff/shipments/chaipai-photos", { auth: CLIENT, query: { trackingNo: `ZZCPT${stamp}1` } })).status, 403);
      const none = await call("GET /staff/shipments/chaipai-photos", { auth: STAFF, query: { trackingNo: `ZZCPT${stamp}4` } });
      assert.equal(none.raw.data.state, "none");
      process.env.CHAIPAI_ENABLED = "false";
      const off = await call("GET /staff/shipments/chaipai-photos", { auth: ADMIN, query: { trackingNo: `ZZCPT${stamp}1` } });
      enable();
      assert.equal(off.raw.data.state, "disabled");
    });
    await test("F2 单张：成功回 base64；410 回 410「照片已过保留期」；照片编号乱写 400；只读接口坏了 → 列表是 unavailable", async () => {
      fake.set(S1, { route: routeA, photos: [
        { id: "ok1", createdAt: "2026-10-12T01:00:00.000Z", bytes: Buffer.from("HELLO") },
        { id: "gone1", createdAt: "2026-10-12T02:00:00.000Z", status: 410 },
      ] });
      const ok1 = await call("GET /staff/shipments/chaipai-photo", { auth: STAFF, query: { trackingNo: `ZZCPT${stamp}1`, photoId: "ok1" } });
      assert.deepEqual([ok1.raw.data.contentType, ok1.raw.data.dataBase64], ["image/jpeg", Buffer.from("HELLO").toString("base64")]);
      const gone = await call("GET /staff/shipments/chaipai-photo", { auth: STAFF, query: { trackingNo: `ZZCPT${stamp}1`, photoId: "gone1" } });
      assert.deepEqual([gone.status, gone.raw.message], [410, "照片已过保留期"]);
      assert.equal((await call("GET /staff/shipments/chaipai-photo", { auth: STAFF, query: { trackingNo: `ZZCPT${stamp}1`, photoId: "../x" } })).status, 400);
      fake.set(S1, { status: 500 });
      const broken = await call("GET /staff/shipments/chaipai-photos", { auth: STAFF, query: { trackingNo: `ZZCPT${stamp}1` } });
      assert.equal(broken.raw.data.state, "unavailable");
      assert.ok(!JSON.stringify([ok1.raw, broken.raw]).includes(READ), "响应里出现了只读密钥");
    });
  } finally {
    await cleanup();
    await pm.$disconnect();
    server.close();
  }
  console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项不通过`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
