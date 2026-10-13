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
    console.log(`  ❌ ${label}\n     ${e instanceof Error ? e.message.split("\n").slice(0, 12).join("\n     ") : String(e)}`);
  }
}

/** 假拆派仓只读接口：按运单 id 配好详情和照片 */
interface FakePhoto { id: string; createdAt: string; status?: number; bytes?: Buffer; type?: string; delayMs?: number }
interface FakeShipment { status?: number; route?: Row | null; handover?: Row | null; photos?: FakePhoto[]; slowBody?: boolean; pageDelayMs?: number }
const fake = new Map<string, FakeShipment>();
const fakeHits: string[] = [];

function startFake(): Promise<Server> {
  const server = createServer(async (req, res) => {
    fakeHits.push(req.url ?? "");
    if (req.headers.authorization !== `Bearer ${READ}`) { res.statusCode = 401; res.end("{}"); return; }
    const u = new URL(req.url ?? "/", "http://x");
    const m = /^\/integrations\/domestic\/v2\/shipments\/([^/]+)(?:\/photos\/([^/]+))?$/.exec(u.pathname);
    const s = m ? fake.get(decodeURIComponent(m[1])) : undefined;
    if (!m || !s) { res.statusCode = 404; res.end("{}"); return; }
    if (s.status && s.status !== 200) { res.statusCode = s.status; res.end("{}"); return; }
    // 先回头、内容迟迟不发完（考读响应体也有超时）
    if (s.slowBody && !m[2]) { res.writeHead(200, { "content-type": "application/json" }); res.write('{"code":"OK","data":'); return; }
    const photos = [...(s.photos ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1)); // 拆派仓按 id 升序
    if (m[2]) {
      const p = photos.find((x) => x.id === decodeURIComponent(m[2]));
      if (!p) { res.statusCode = 404; res.end("{}"); return; }
      if (p.status && p.status !== 200) { res.statusCode = p.status; res.end("{}"); return; }
      if (p.delayMs) await new Promise((r) => setTimeout(r, p.delayMs));
      if (res.destroyed) return;
      res.setHeader("content-type", p.type ?? "image/jpeg");
      res.end(p.bytes ?? Buffer.from(`JPEG-${p.id}`));
      return;
    }
    if (s.pageDelayMs) await new Promise((r) => setTimeout(r, s.pageDelayMs));
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
  (await import("../apps/api/src/modules/admin-ops/routes")).registerAdminOpsRoutes(app);

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

    console.log("\n【按运单号取一票（10-13）】");
    const byNo = (waybillNo: string, secret = PULL) =>
      call("GET /integrations/chaipai/v2/waybill-manifest", { query: { waybillNo }, authorization: `Bearer ${secret}` });
    const shipsOf = (raw: Row) => raw.manifests.flatMap((m: Row) => m.shipments.map((s: Row) => ({ ...s, _containerNo: m.containerNo, _batchKey: m.batchKey, _batchNo: m.batchNo })));
    await test("N1 密钥不对 401（拉清单密钥以外的都不认）；开关关着 503；没这个号 404；空的 / 控制字符 400", async () => {
      assert.equal((await byNo(`ZZCPT${stamp}1`, "wrong-secret-wrong-secret-wrong-secret")).status, 401);
      assert.equal((await byNo(`ZZCPT${stamp}1`, CB)).status, 401);
      process.env.CHAIPAI_ENABLED = "false";
      assert.equal((await byNo(`ZZCPT${stamp}1`)).status, 503);
      enable();
      assert.equal((await byNo(`ZZCPNOSUCH${stamp}`)).status, 404);
      assert.equal((await byNo("   ")).status, 400);
      assert.equal((await byNo("A\u0001B")).status, 400);
    });
    await test("N2 子单号 → 只回这一张；跟按柜拉的同一份（batchKey、batchNo、柜号、字段、版本时间一字不差）；首尾空格能对上、顶层原样回", async () => {
      const viaCtn = shipsOf((await pull(ctnNo)).raw);
      const r = await byNo(`  ${parentNo}-1 `);
      assert.equal(r.status, 200, JSON.stringify(r.raw).slice(0, 200));
      assert.deepEqual([r.raw.code, r.raw.protocolVersion, r.raw.companyId, r.raw.waybillNo, "containerNo" in r.raw], [undefined, 2, "xiangtai", `  ${parentNo}-1 `, false]);
      const got = shipsOf(r.raw);
      assert.deepEqual(got.map((s: Row) => s.sourceShipmentId), [K1]);
      assert.deepEqual(got[0], viaCtn.find((s: Row) => s.sourceShipmentId === K1));
      assert.equal(r.raw.manifests[0].containerNo, ctnNo);
    });
    await test("N3 父单号 → 回它下面全部子票（0 件的汇总父单不放）；大小写不一样对不上（湘泰运单号区分大小写）", async () => {
      const r = await byNo(parentNo);
      assert.equal(r.status, 200);
      assert.deepEqual(shipsOf(r.raw).map((s: Row) => s.sourceShipmentId).sort(), [K1, K2].sort());
      assert.ok(shipsOf(r.raw).every((s: Row) => s.parentWaybillNo === parentNo && s._batchNo === "B2"));
      assert.equal((await byNo(parentNo.toLowerCase())).status, 404);
    });
    await test("N4 子单分在两个柜 → 每个柜一份、各带自己的柜号；挂两个柜的票取最近装的那个柜（件数是那个柜的）", async () => {
      const K3 = await seedShipment({ orderId: oP, trackingNo: `${parentNo}-3`, parent: parentNo, pieces: 4, status: "departed", batchNo: "B2", weightKg: 44 });
      await load(C2, K3, 4, 2.0);
      try {
        const r = await byNo(parentNo);
        assert.equal(r.status, 200);
        const byCtn = Object.fromEntries(r.raw.manifests.map((m: Row) => [m.containerNo, m.shipments.map((s: Row) => s.sourceShipmentId).sort()]));
        assert.deepEqual(byCtn, { [ctnNo]: [K1, K2].sort(), [`ZZCP${stamp}02`]: [K3] });
        // 同一个父单在两个柜里 batchKey 不一样（跟按柜拉一样：batchKey 跟柜子 id 走）
        assert.notEqual(r.raw.manifests[0].batchKey, r.raw.manifests[1].batchKey);
      } finally {
        await pm.chaipaiManifestVersion.deleteMany({ where: { shipmentId: K3 } });
        await pm.shipmentContainerItem.deleteMany({ where: { shipmentId: K3 } });
        await pm.shipment.delete({ where: { id: K3 } });
      }
      // MULTI 挂 C1、C2 两个柜：按装柜时间取最近的那个（两个方向都试，不靠插入先后）
      const setLoadedAt = (containerId: string, at: Date) => pm.shipmentContainerItem.updateMany({ where: { shipmentId: MULTI, containerId }, data: { createdAt: at } });
      await setLoadedAt(C1, new Date(Date.UTC(2026, 9, 1)));
      await setLoadedAt(C2, new Date(Date.UTC(2026, 9, 5)));
      const m = await byNo(`ZZCPT${stamp}4`);
      assert.equal(m.status, 200);
      const one = shipsOf(m.raw);
      assert.deepEqual([one.length, one[0].sourceShipmentId, one[0]._containerNo, one[0].boxCount], [1, MULTI, `ZZCP${stamp}02`, 1]);
      await setLoadedAt(C1, new Date(Date.UTC(2026, 9, 9)));
      const back = shipsOf((await byNo(`ZZCPT${stamp}4`)).raw);
      assert.deepEqual([back.length, back[0]._containerNo], [1, ctnNo]);
    });
    await test("N5 整柜的票 404；没装过柜的票 404；再取一次版本时间不变、改了件数才变大", async () => {
      assert.equal((await byNo(`ZZCPT${stamp}5`)).status, 404);
      const oX = await seedOrder("ZZCPA", 2, 20);
      const notLoaded = await seedShipment({ orderId: oX, trackingNo: `ZZCPT${stamp}6`, pieces: 2, status: "inWarehouseCN" });
      try {
        assert.equal((await byNo(`ZZCPT${stamp}6`)).status, 404);
      } finally {
        await pm.shipment.delete({ where: { id: notLoaded } });
      }
      const v1 = shipsOf((await byNo(`ZZCPT${stamp}1`)).raw)[0].sourceUpdatedAt;
      assert.equal(shipsOf((await byNo(`ZZCPT${stamp}1`)).raw)[0].sourceUpdatedAt, v1);
      assert.equal(shipsOf((await pull(ctnNo)).raw).find((s: Row) => s.sourceShipmentId === S1).sourceUpdatedAt, v1, "跟按柜拉同一个版本");
      await pm.shipmentContainerItem.updateMany({ where: { containerId: C1, shipmentId: S1 }, data: { loadedVolumeM3: 1.6 } });
      const v2 = shipsOf((await byNo(`ZZCPT${stamp}1`)).raw)[0];
      assert.ok(v2.sourceUpdatedAt > v1, "内容变了版本要变大");
      assert.equal(v2.volumeM3, 1.6);
      await pm.shipmentContainerItem.updateMany({ where: { containerId: C1, shipmentId: S1 }, data: { loadedVolumeM3: 1.5 } });
    });
    await test("N6 同一个柜同时来几次（按运单号 + 按柜拉混着）都 200、版本一致，不死锁", async () => {
      const rs = await Promise.all([byNo(parentNo), pull(ctnNo), byNo(`${parentNo}-2`), byNo(parentNo), pull(ctnNo)]);
      assert.deepEqual(rs.map((x) => x.status), [200, 200, 200, 200, 200]);
      const k2 = rs.map((x) => (x.raw.manifests as Row[]).flatMap((m) => m.shipments).find((s: Row) => s.sourceShipmentId === K2)?.sourceUpdatedAt);
      assert.ok(k2.every(Boolean), `每个回复里都要有 K2：${JSON.stringify(k2)}`);
      const k2Batch = rs.map((x) => (x.raw.manifests as Row[]).find((m) => m.shipments.some((s: Row) => s.sourceShipmentId === K2)));
      assert.ok(k2Batch.every((m) => m && m.batchKey && m.batchNo === "B2" && m.containerNo === ctnNo), "批次身份要齐全");
      assert.equal(new Set(k2Batch.map((m) => m!.batchKey)).size, 1, "两条路的 batchKey 要一样");
      assert.equal(new Set(k2).size, 1, JSON.stringify(k2));
    });
    await test("N7 父单子票跨两个柜（要拿两把锁）跟两个柜各自按柜拉、按子单号取一起来：全 200、同一票版本一致，不死锁", async () => {
      const K4 = await seedShipment({ orderId: oP, trackingNo: `${parentNo}-4`, parent: parentNo, pieces: 2, status: "departed", batchNo: "B2", weightKg: 20 });
      await load(C2, K4, 2, 1.0);
      try {
        for (let round = 0; round < 3; round++) {
          const rs = await Promise.all([byNo(parentNo), pull(`ZZCP${stamp}02`), pull(ctnNo), byNo(`${parentNo}-4`), byNo(parentNo), pull(`ZZCP${stamp}02`)]);
          assert.deepEqual(rs.map((x) => x.status), [200, 200, 200, 200, 200, 200], `第 ${round + 1} 轮`);
          for (const id of [K1, K4]) {
            const v = rs.map((x) => (x.raw.manifests as Row[]).flatMap((m) => m.shipments).find((s: Row) => s.sourceShipmentId === id)?.sourceUpdatedAt).filter(Boolean);
            assert.ok(v.length >= 3 && new Set(v).size === 1, `${id} 版本不一致：${JSON.stringify(v)}`);
          }
        }
      } finally {
        await pm.chaipaiManifestVersion.deleteMany({ where: { shipmentId: K4 } });
        await pm.shipmentContainerItem.deleteMany({ where: { shipmentId: K4 } });
        await pm.shipment.delete({ where: { id: K4 } });
      }
    });
    await test("N8 排队期间票被挪进没排队的柜 → 503「正忙，请稍后再扫一次」，不硬取（删了拿锁后的那两道检查这项就红）", async () => {
      const ctn = await pm.container.findFirst({ where: { containerNo: ctnNo }, select: { id: true } });
      let release!: () => void;
      const hold = new Promise<void>((r) => { release = r; });
      let gotLock!: () => void;
      const locked = new Promise<void>((r) => { gotLock = r; });
      const holder = pm.$transaction(async (tx: any) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(83060, hashtext(${ctn.id}))`;
        gotLock();
        await hold;
      }, { timeout: 15000 });
      await locked;
      const pending = byNo(`${parentNo}-1`); // 先读到 K1 在 C1，然后卡在 C1 的锁上
      // 等它真的卡在锁上（看数据库里有没有一个还没拿到的 83060 咨询锁），不靠猜时间
      for (let i = 0; i < 100; i++) {
        const w: Row[] = await pm.$queryRaw`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 83060 AND NOT granted`;
        if (w.length > 0) break;
        await new Promise((r) => setTimeout(r, 30));
      }
      await pm.shipmentContainerItem.updateMany({ where: { shipmentId: K1, containerId: C1 }, data: { containerId: C2 } });
      try {
        release();
        await holder;
        const r = await pending;
        assert.deepEqual([r.status, r.raw?.message], [503, "正忙，请稍后再扫一次"]);
      } finally {
        await pm.shipmentContainerItem.updateMany({ where: { shipmentId: K1, containerId: C2 }, data: { containerId: C1 } });
      }
      assert.equal((await byNo(`${parentNo}-1`)).status, 200, "挪回来以后照常能取");
    });
    await test("N9 明细读完、版本都写下了票才被挪柜 → 提交前再核一次发现变了：503、这次写的版本整个撤回（Codex 10-13；删了最后那道检查这项就红）", async () => {
      const before = await pm.chaipaiManifestVersion.findUnique({ where: { shipmentId: K1 } });
      assert.ok(before, "前提：K1 已经有版本记录");
      // 把 K1 这行版本记录先锁住：取票走到写版本那一步就停在那里（此时明细已经读完）
      let release!: () => void;
      const hold = new Promise<void>((r) => { release = r; });
      let gotLock!: () => void;
      const locked = new Promise<void>((r) => { gotLock = r; });
      const holder = pm.$transaction(async (tx: any) => {
        await tx.$queryRaw`SELECT 1 FROM chaipai_manifest_versions WHERE shipment_id = ${K1} FOR UPDATE`;
        gotLock();
        await hold;
      }, { timeout: 15000 });
      await locked;
      // 先改一下内容（件数方数），让这次取票一定要去写版本（内容没变的话 ON CONFLICT 也会锁这一行，这里双保险）
      await pm.shipmentContainerItem.updateMany({ where: { shipmentId: K1, containerId: C1 }, data: { loadedVolumeM3: 1.1 } });
      const pending = byNo(`${parentNo}-1`);
      let waited = false;
      for (let i = 0; i < 150; i++) {
        const w: Row[] = await pm.$queryRaw`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%chaipai_manifest_versions%' AND query NOT ILIKE '%FOR UPDATE%'`;
        if (w.length > 0) { waited = true; break; }
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.ok(waited, "前提：取票真的停在写版本那一步");
      await pm.shipmentContainerItem.updateMany({ where: { shipmentId: K1, containerId: C1 }, data: { containerId: C2 } });
      try {
        release();
        await holder;
        const r = await pending;
        assert.deepEqual([r.status, r.raw?.message], [503, "正忙，请稍后再扫一次"]);
        const after = await pm.chaipaiManifestVersion.findUnique({ where: { shipmentId: K1 } });
        assert.deepEqual([after.contentHash, after.versionAt.toISOString()], [before.contentHash, before.versionAt.toISOString()], "这次写的版本要整个撤回");
      } finally {
        await pm.shipmentContainerItem.updateMany({ where: { shipmentId: K1, containerId: C2 }, data: { containerId: C1, loadedVolumeM3: 1.0 } });
      }
      assert.equal((await byNo(`${parentNo}-1`)).status, 200, "挪回来以后照常能取");
    });

    console.log("\n【收回传：状态和轨迹】");
    await test("R1 密钥不对 401；格式不对 400；公司编号不对 409；湘泰没有这票 → IGNORED_OLDER 什么都不写", async () => {
      assert.equal((await call("POST /integrations/chaipai/v2/events", { body: {}, authorization: "Bearer nope" })).status, 401);
      assert.equal((await call("POST /integrations/chaipai/v2/events", { body: { protocolVersion: 2 }, authorization: `Bearer ${CB}` })).status, 400);
      assert.equal((await send(S1, "ARRIVED", { companyId: "other" })).status, 409);
      const r = await send(`${P}nosuch`, "ARRIVED");
      assert.deepEqual([r.status, r.raw], [200, { eventId: r.body.eventId, result: "IGNORED_OLDER" }]);
      // 回了「收到」就留底（公司编号空着），同一编号再来认得出：一样的回 DUPLICATE、换了内容回 409
      const row = await pm.chaipaiCallbackEvent.findUnique({ where: { eventId: r.body.eventId } });
      assert.deepEqual([row?.result, row?.companyId], ["IGNORED_OLDER", null]);
      const again = await call("POST /integrations/chaipai/v2/events", { body: r.body, authorization: `Bearer ${CB}` });
      assert.equal(again.raw.result, "DUPLICATE");
      const changed = await call("POST /integrations/chaipai/v2/events", { body: { ...r.body, batchNo: "其它批次" }, authorization: `Bearer ${CB}` });
      assert.equal(changed.status, 409);
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


    console.log("\n【审查补的（10-12 Codex / dsh 第 1 轮）】");
    const fresh = async (tag: string, status = "inWarehouseTH") => {
      const o = await seedOrder("ZZCPA", 1, 5);
      return seedShipment({ orderId: o, trackingNo: `ZZCPT${stamp}${tag}`, pieces: 1, status });
    };
    const manualRow = (id: string, shipmentId: string, deliveryNo: string, status: string, extra: Row = {}) =>
      pm.adminLastmileOrder.create({ data: { id: `${P}${id}`, companyId: CO, deliveryNo, shipmentId, carrierName: "自营",
        externalTrackingNo: "", driverName: "员工司机", licensePlate: "X1", phoneNumber: "0991", deliveryDate: "2026-10-12", status, ...extra } });

    await test("V1 派送中之后收到已装车：状态不动、派送单不撤，只记「泰国已装车」（不当成拉回仓）", async () => {
      const SV1 = await fresh("V1");
      fake.set(SV1, { route: { ...routeA, id: `${P}routeV1` }, photos: [] });
      await send(SV1, "OUT_FOR_DELIVERY");
      await send(SV1, "LOADED");
      const rows = await rowsOf(SV1);
      const logs = await logsOf(SV1);
      assert.deepEqual([(await shipmentOf(SV1)).currentStatus, rows.length, rows[0].status, logs[logs.length - 1].remark, logs[logs.length - 1].toStatus],
        ["outForDelivery", 1, "DELIVERING", "泰国已装车", "outForDelivery"]);
    });
    await test("V2 员工签过一趟又派一趟、拆派仓说已到仓：那张已签收照「撤销误签收」退回再一起撤掉，不留「在仓 + 已签收」", async () => {
      const SV2 = await fresh("V2", "outForDelivery");
      await manualRow("v2a", SV2, "WDZZV2A", "SIGNED", { signImageBase64: "AAAA" });
      await manualRow("v2b", SV2, "WDZZV2B", "DELIVERING");
      await send(SV2, "ARRIVED");
      assert.equal((await shipmentOf(SV2)).currentStatus, "inWarehouseTH");
      assert.equal((await rowsOf(SV2)).length, 0, "不能留下已签收的单");
      const logs = (await logsOf(SV2)).slice(-2);
      assert.match(logs[0].remark, /^撤销误签收（WDZZV2A）/);
      assert.equal(logs[1].remark, "未送达，已回泰国仓");
    });
    await test("V3 签收过两张（派了两趟都签）又说已到仓：分不清撤哪张 → 503、一个字不写（同手工撤销签收第四道闸）", async () => {
      const SV3 = await fresh("V3", "delivered");
      await manualRow("v3a", SV3, "WDZZV3A", "SIGNED");
      await manualRow("v3b", SV3, "WDZZV3B", "SIGNED");
      const r = await send(SV3, "ARRIVED");
      assert.equal(r.status, 503);
      assert.deepEqual([(await shipmentOf(SV3)).currentStatus, (await rowsOf(SV3)).length, await pm.chaipaiCallbackEvent.count({ where: { eventId: r.body.eventId } })],
        ["delivered", 2, 0]);
    });
    await test("V4 签收时优先签派送中的那张（跟踪的旧单员工已签过、又手工派了一趟），不会留一张派送中", async () => {
      const SV4 = await fresh("V4");
      fake.set(SV4, { route: { ...routeA, id: `${P}routeV4` }, photos: [{ id: "v4p", createdAt: "2026-10-12T03:00:00.000Z" }] });
      await send(SV4, "OUT_FOR_DELIVERY");
      const auto = (await rowsOf(SV4))[0];
      await pm.adminLastmileOrder.update({ where: { id: auto.id }, data: { status: "SIGNED" } });
      await manualRow("v4b", SV4, "WDZZV4B", "DELIVERING");
      await send(SV4, "DELIVERED");
      const rows = await rowsOf(SV4);
      assert.deepEqual(rows.map((r: Row) => r.status).sort(), ["SIGNED", "SIGNED"]);
      assert.equal(rows.find((r: Row) => r.id === `${P}v4b`).status, "SIGNED");
    });
    await test("V5 换了一趟车（中间「回仓」没收到）：自动登记的旧单照「改派」撤掉，按新车发新 WD，同车的票共用新号", async () => {
      const SV5 = await fresh("V5");
      const SV5b = await fresh("V5b");
      fake.set(SV5, { route: { ...routeA, id: `${P}routeV5a` }, photos: [] });
      await send(SV5, "OUT_FOR_DELIVERY");
      const oldNo = (await rowsOf(SV5))[0].deliveryNo;
      fake.set(SV5, { route: { ...routeA, id: `${P}routeV5b`, driverName: "王五" }, photos: [] });
      await send(SV5, "OUT_FOR_DELIVERY", {}, { seq: (seqOf.get(SV5) ?? 0) + 2 });
      const rows = await rowsOf(SV5);
      assert.equal(rows.length, 1);
      assert.notEqual(rows[0].deliveryNo, oldNo);
      assert.equal(rows[0].driverName, "王五");
      const logs = await logsOf(SV5);
      assert.equal(logs[logs.length - 1].remark, `改派：从 ${oldNo} 转到 ${rows[0].deliveryNo}，司机【王五】正在为您派送，请注意查收`);
      fake.set(SV5b, { route: { ...routeA, id: `${P}routeV5b`, driverName: "王五" }, photos: [] });
      await send(SV5b, "OUT_FOR_DELIVERY");
      assert.equal((await rowsOf(SV5b))[0].deliveryNo, rows[0].deliveryNo);
    });
    await test("V6 接手员工手工单后再来派送中：员工填的司机车牌承运商都不改，也不重复写「正在派送」", async () => {
      const SV6 = await fresh("V6", "outForDelivery");
      await manualRow("v6", SV6, "WDZZV6", "DELIVERING");
      fake.set(SV6, { route: { ...routeA, id: `${P}routeV6` }, handover: { carrierName: "Kerry", trackingNo: "K9" }, photos: [] });
      const before = (await logsOf(SV6)).length;
      await send(SV6, "OUT_FOR_DELIVERY");
      await send(SV6, "OUT_FOR_DELIVERY");
      const row = (await rowsOf(SV6))[0];
      assert.deepEqual([row.id, row.driverName, row.licensePlate, row.carrierName, row.externalTrackingNo], [`${P}v6`, "员工司机", "X1", "自营", ""]);
      assert.equal((await logsOf(SV6)).length, before, "接手员工单不该再写派送中");
    });
    await test("V7 员工已手工签收（带了图），拆派仓签收到了：图换成拆派仓最新那张；没跟踪也不再建第二张已签收", async () => {
      const SV7 = await fresh("V7", "delivered");
      await manualRow("v7", SV7, "WDZZV7", "SIGNED", { signImageBase64: "AAAA" });
      fake.set(SV7, { route: routeA, photos: [{ id: "v7p", createdAt: "2026-10-12T03:00:00.000Z", bytes: Buffer.from("CHAIPAI-V7") }] });
      await send(SV7, "DELIVERED", {}, { occurredAt: "2026-10-12T04:00:00.000Z" });
      const rows = await rowsOf(SV7);
      assert.deepEqual(rows.map((r: Row) => [r.id, r.status, r.signImageBase64]), [[`${P}v7`, "SIGNED", Buffer.from("CHAIPAI-V7").toString("base64")]]);
    });
    await test("V8 转交单号改了（承运商没变）：派送单换成新单号、补一条轨迹", async () => {
      const SV8 = await fresh("V8");
      fake.set(SV8, { route: null, handover: { carrierName: "Kerry", trackingNo: "K1" }, photos: [] });
      await send(SV8, "OUT_FOR_DELIVERY");
      fake.set(SV8, { route: null, handover: { carrierName: "Kerry", trackingNo: "K2" }, photos: [] });
      await send(SV8, "OUT_FOR_DELIVERY");
      const row = (await rowsOf(SV8))[0];
      const logs = await logsOf(SV8);
      assert.deepEqual([row.externalTrackingNo, logs[logs.length - 1].remark], ["K2", "已交给【Kerry】派送，单号 K2，请注意查收"]);
    });
    await test("V9 拆派仓回了头、内容迟迟不发完：照样按时断开回 503，一个字不写", async () => {
      const SV9 = await fresh("V9");
      fake.set(SV9, { slowBody: true });
      const t0 = Date.now();
      const r = await send(SV9, "OUT_FOR_DELIVERY");
      assert.equal(r.status, 503);
      assert.ok(Date.now() - t0 < 9000, `等了 ${Date.now() - t0}ms，超过拆派仓的 10 秒`);
      assert.equal((await rowsOf(SV9)).length, 0);
    });
    await test("V10 照片 250 张（超过以前的 200 张上限）：签收照样翻完全部、挑到最新那张", async () => {
      const SV10 = await fresh("V10");
      const photos = Array.from({ length: 250 }, (_, i) => ({ id: `q${String(i).padStart(3, "0")}`, createdAt: new Date(Date.UTC(2026, 9, 12, 1, 0, i)).toISOString(),
        bytes: Buffer.from(`P${i}`) }));
      photos[7].createdAt = "2026-10-12T02:59:00.000Z"; // 最新的那张在 id 排序里很靠前，时间最晚
      photos[240].createdAt = "2026-10-12T02:58:00.000Z";
      fake.set(SV10, { route: routeA, photos });
      await send(SV10, "DELIVERED", {}, { occurredAt: "2026-10-12T03:00:00.000Z" });
      assert.equal((await rowsOf(SV10))[0].signImageBase64, Buffer.from("P7").toString("base64"));
    });
    await test("V11 空柜（柜子在、里面没货）→ 200 + manifests: []；整柜号跟拼柜号只差空格 → 409 不给错柜子", async () => {
      const emptyNo = `ZZCPE${stamp}`;
      await seedContainer(emptyNo);
      const r = await pull(emptyNo);
      assert.deepEqual([r.status, r.raw.manifests], [200, []]);
      await seedContainer(`ZZCPF ${stamp}`, true);
      await seedContainer(`ZZCPF${stamp}`);
      assert.equal((await pull(`ZZCPF${stamp}`)).status, 409);
    });
    await test("V12 同一个柜两个人同时拉：两边拿到的版本时间一样（排队锁）", async () => {
      const [a, b] = await Promise.all([pull(ctnNo), pull(ctnNo)]);
      const va = a.raw.manifests.flatMap((m: Row) => m.shipments).map((x: Row) => `${x.sourceShipmentId}@${x.sourceUpdatedAt}`).sort();
      const vb = b.raw.manifests.flatMap((m: Row) => m.shipments).map((x: Row) => `${x.sourceShipmentId}@${x.sourceUpdatedAt}`).sort();
      assert.deepEqual([a.status, b.status], [200, 200]);
      assert.deepEqual(va, vb);
    });
    await test("V13 回传和员工手工建派送单同时来（各 5 回合）：不死锁、不报 500，这票最多一张派送中", async () => {
      for (let i = 0; i < 5; i++) {
        const SC = await fresh(`C${i}`);
        fake.set(SC, { route: { ...routeA, id: `${P}routeC${i}` }, photos: [] });
        const [ev, manual] = await Promise.all([
          send(SC, "OUT_FOR_DELIVERY"),
          call("POST /admin/lastmile/orders", { auth: STAFF, body: { shipmentIds: [SC], driverName: "手工司机" } }),
        ]);
        assert.ok([200, 503].includes(ev.status), `回传 ${ev.status}`);
        assert.ok([200, 409].includes(manual.status), `手工建单 ${manual.status} ${manual.raw?.message ?? ""}`);
        if (ev.status === 503) {
          const again = await call("POST /integrations/chaipai/v2/events", { body: ev.body, authorization: `Bearer ${CB}` });
          assert.equal(again.raw.result, "APPLIED");
        }
        const rows = await rowsOf(SC);
        assert.equal(rows.filter((r: Row) => r.status === "DELIVERING").length, 1, `第 ${i} 回合派送中 ${rows.length} 张`);
        assert.equal((await shipmentOf(SC)).currentStatus, "outForDelivery");
      }
    });
    await test("V15 同一趟车里有一票接手了员工手工单：同车别的票不会并进员工那张单的号", async () => {
      const SM = await fresh("V15m", "outForDelivery");
      await manualRow("v15", SM, "WDZZV15", "DELIVERING");
      const route15 = { ...routeA, id: `${P}routeV15` };
      fake.set(SM, { route: route15, photos: [] });
      await send(SM, "OUT_FOR_DELIVERY");
      const SO = await fresh("V15o");
      fake.set(SO, { route: route15, photos: [] });
      await send(SO, "OUT_FOR_DELIVERY");
      const no = (await rowsOf(SO))[0].deliveryNo;
      assert.notEqual(no, "WDZZV15");
      assert.match(no, /^WD\d{6}$/);
    });
    await test("V16 换趟：上一趟是转交、这趟换成自己的车（中间「回仓」没收到）→ 自动单撤旧发新 WD", async () => {
      const S16 = await fresh("V16");
      fake.set(S16, { route: null, handover: { carrierName: "Kerry", trackingNo: "K16" }, photos: [] });
      await send(S16, "OUT_FOR_DELIVERY");
      const oldNo = (await rowsOf(S16))[0].deliveryNo;
      fake.set(S16, { route: { ...routeA, id: `${P}routeV16` }, handover: null, photos: [] });
      await send(S16, "OUT_FOR_DELIVERY", {}, { seq: (seqOf.get(S16) ?? 0) + 2 });
      const rows = await rowsOf(S16);
      assert.equal(rows.length, 1);
      assert.notEqual(rows[0].deliveryNo, oldNo);
      assert.deepEqual([rows[0].carrierName, rows[0].driverName, rows[0].externalTrackingNo], ["自营", "张三", ""]);
    });
    await test("V17 换趟：上一趟是自己的车、这趟转交给别的物流 → 撤旧发新 WD，司机车牌不留上一趟的", async () => {
      const S17 = await fresh("V17");
      fake.set(S17, { route: { ...routeA, id: `${P}routeV17` }, photos: [] });
      await send(S17, "OUT_FOR_DELIVERY");
      const oldNo = (await rowsOf(S17))[0].deliveryNo;
      fake.set(S17, { route: null, handover: { carrierName: "Flash", trackingNo: "F17" }, photos: [] });
      await send(S17, "OUT_FOR_DELIVERY", {}, { seq: (seqOf.get(S17) ?? 0) + 2 });
      const rows = await rowsOf(S17);
      assert.equal(rows.length, 1);
      assert.notEqual(rows[0].deliveryNo, oldNo);
      assert.deepEqual([rows[0].carrierName, rows[0].externalTrackingNo, rows[0].driverName, rows[0].licensePlate], ["Flash", "F17", "", ""]);
    });
    await test("V18 换趟后那条「派送中」丢了、直接收到已签收 → 旧趟的自动单撤掉，按这一趟登记已签收（新 WD）", async () => {
      const S18 = await fresh("V18");
      fake.set(S18, { route: { ...routeA, id: `${P}routeV18a` }, photos: [] });
      await send(S18, "OUT_FOR_DELIVERY");
      const oldNo = (await rowsOf(S18))[0].deliveryNo;
      fake.set(S18, { route: { ...routeA, id: `${P}routeV18b`, driverName: "赵六" }, photos: [{ id: "p18", createdAt: "2026-10-12T03:00:00.000Z" }] });
      await send(S18, "DELIVERED", {}, { seq: (seqOf.get(S18) ?? 0) + 3 });
      const rows = await rowsOf(S18);
      assert.equal(rows.length, 1);
      assert.deepEqual([rows[0].status, rows[0].driverName, rows[0].deliveryNo !== oldNo, !!rows[0].signImageBase64], ["SIGNED", "赵六", true, true]);
      assert.equal((await shipmentOf(S18)).currentStatus, "delivered");
    });
    await test("V18b 旧趟的自动单员工已经手工签过、新一趟直接收到已签收 → 旧单撤掉，按新一趟登记已签收（新 WD）", async () => {
      const S = await fresh("V18b");
      fake.set(S, { route: { ...routeA, id: `${P}routeV18c` }, photos: [] });
      await send(S, "OUT_FOR_DELIVERY");
      const old = (await rowsOf(S))[0];
      await pm.adminLastmileOrder.update({ where: { id: old.id }, data: { status: "SIGNED" } });
      await pm.shipment.update({ where: { id: S }, data: { currentStatus: "delivered" } });
      fake.set(S, { route: { ...routeA, id: `${P}routeV18d`, driverName: "钱七" }, photos: [{ id: "p18b", createdAt: "2026-10-12T03:00:00.000Z" }] });
      await send(S, "DELIVERED", {}, { seq: (seqOf.get(S) ?? 0) + 3 });
      const rows = await rowsOf(S);
      assert.equal(rows.length, 1);
      assert.deepEqual([rows[0].status, rows[0].driverName, rows[0].deliveryNo !== old.deliveryNo], ["SIGNED", "钱七", true]);
    });
    await test("V22 过时的「派送中」（拆派仓查得到这票、但现在不在车上也没转交）→ 503 不登记认不出趟次的单", async () => {
      const S = await fresh("V22");
      fake.set(S, { route: null, handover: null, photos: [] });
      const r = await send(S, "OUT_FOR_DELIVERY");
      assert.equal(r.status, 503);
      assert.deepEqual([(await rowsOf(S)).length, (await shipmentOf(S)).currentStatus], [0, "inWarehouseTH"]);
    });
    await test("V23 两次都是转交、中间漏了撤回：换了物流公司、或同一家又跳了号，都是新的一趟（新 WD）；连着的号只是改单号仍是同一趟（见 V8）", async () => {
      const S = await fresh("V23");
      fake.set(S, { route: null, handover: { carrierName: "Kerry", trackingNo: "K1" }, photos: [] });
      await send(S, "OUT_FOR_DELIVERY");
      const wd1 = (await rowsOf(S))[0].deliveryNo;
      fake.set(S, { route: null, handover: { carrierName: "Flash", trackingNo: "F2" }, photos: [] });
      await send(S, "OUT_FOR_DELIVERY", {}, { seq: (seqOf.get(S) ?? 0) + 2 });
      let rows = await rowsOf(S);
      assert.deepEqual([rows.length, rows[0].deliveryNo !== wd1, rows[0].carrierName, rows[0].externalTrackingNo], [1, true, "Flash", "F2"]);
      const wd2 = rows[0].deliveryNo;
      // 同一家 Flash 又转交一次（中间撤回丢了、出车那条也丢了，直接签收）
      fake.set(S, { route: null, handover: { carrierName: "Flash", trackingNo: "F3" }, photos: [{ id: "p23", createdAt: "2026-10-12T03:00:00.000Z" }] });
      await send(S, "DELIVERED", {}, { seq: (seqOf.get(S) ?? 0) + 3 });
      rows = await rowsOf(S);
      assert.deepEqual([rows.length, rows[0].status, rows[0].deliveryNo !== wd2, rows[0].externalTrackingNo], [1, "SIGNED", true, "F3"]);
    });
    await test("V24 已登记司机车牌的自动单，后来再来派送中、只读接口这回查不到（404）→ 司机车牌原样留着", async () => {
      const S = await fresh("V24");
      fake.set(S, { route: { ...routeA, id: `${P}routeV24` }, photos: [] });
      await send(S, "OUT_FOR_DELIVERY");
      fake.delete(S);
      await send(S, "OUT_FOR_DELIVERY");
      const row = (await rowsOf(S))[0];
      assert.deepEqual([row.driverName, row.licensePlate, row.carrierName], ["张三", "1กข1234", "自营"]);
    });
    await test("V25 派送中那次查不到（404，司机车牌空着）、签收时查到了 → 签收时把司机车牌补上、记下这趟车", async () => {
      const S = await fresh("V25");
      fake.delete(S);
      await send(S, "OUT_FOR_DELIVERY");
      assert.equal((await rowsOf(S))[0].driverName, "");
      fake.set(S, { route: { ...routeA, id: `${P}routeV25` }, photos: [{ id: "p25", createdAt: "2026-10-12T03:00:00.000Z" }] });
      await send(S, "DELIVERED");
      const row = (await rowsOf(S))[0];
      assert.deepEqual([row.status, row.driverName, row.licensePlate], ["SIGNED", "张三", "1กข1234"]);
      assert.equal((await pm.chaipaiShipmentState.findUnique({ where: { shipmentId: S } })).routeId, `${P}routeV25`);
    });
    await test("V26 同一趟车两票：一票派送中那次查不到（单独发了号）、另一票正常；前者签收时查到了这趟车 → 并到同车那个号", async () => {
      const route26 = { ...routeA, id: `${P}routeV26` };
      const A = await fresh("V26a");
      const B = await fresh("V26b");
      fake.delete(A);
      await send(A, "OUT_FOR_DELIVERY");
      fake.set(B, { route: route26, photos: [] });
      await send(B, "OUT_FOR_DELIVERY");
      const noB = (await rowsOf(B))[0].deliveryNo;
      assert.notEqual((await rowsOf(A))[0].deliveryNo, noB, "前提：两票先各是各的号");
      fake.set(A, { route: route26, photos: [{ id: "p26", createdAt: "2026-10-12T03:00:00.000Z" }] });
      await send(A, "DELIVERED");
      const rowA = (await rowsOf(A))[0];
      assert.deepEqual([rowA.deliveryNo, rowA.status], [noB, "SIGNED"]);
      const logs = await logsOf(A);
      assert.equal(logs[logs.length - 1].remark, `尾程派送已签收（${noB}）`);
      // 同车再来一票，还是这个号
      const C = await fresh("V26c");
      fake.set(C, { route: route26, photos: [] });
      await send(C, "OUT_FOR_DELIVERY");
      assert.equal((await rowsOf(C))[0].deliveryNo, noB);
    });
    await test("V27 同一家物流转交两次、中间撤回丢了（序号跳了）、第二次派送中到了 → 新的一趟（新 WD、新单号）", async () => {
      const S = await fresh("V27");
      fake.set(S, { route: null, handover: { carrierName: "Kerry", trackingNo: "K1" }, photos: [] });
      await send(S, "OUT_FOR_DELIVERY");
      const wd1 = (await rowsOf(S))[0].deliveryNo;
      fake.set(S, { route: null, handover: { carrierName: "Kerry", trackingNo: "K2" }, photos: [] });
      await send(S, "OUT_FOR_DELIVERY", {}, { seq: (seqOf.get(S) ?? 0) + 2 });
      const rows = await rowsOf(S);
      assert.deepEqual([rows.length, rows[0].deliveryNo !== wd1, rows[0].externalTrackingNo], [1, true, "K2"]);
    });
    await test("V28 转交之后收到过已装车（撤回那条丢了）、又转交同一家（序号连着）→ 也是新的一趟", async () => {
      const S = await fresh("V28");
      fake.set(S, { route: null, handover: { carrierName: "Kerry", trackingNo: "K1" }, photos: [] });
      await send(S, "OUT_FOR_DELIVERY");
      const wd1 = (await rowsOf(S))[0].deliveryNo;
      await send(S, "LOADED");
      fake.set(S, { route: null, handover: { carrierName: "Kerry", trackingNo: "K5" }, photos: [] });
      await send(S, "OUT_FOR_DELIVERY");
      const rows = await rowsOf(S);
      assert.deepEqual([rows.length, rows[0].deliveryNo !== wd1, rows[0].externalTrackingNo], [1, true, "K5"]);
    });
    await test("V29 同 V26 但恢复发生在再一次「派送中」：并到同车的号、补一条「改派」轨迹、状态表也跟着改", async () => {
      const route29 = { ...routeA, id: `${P}routeV29` };
      const A = await fresh("V29a");
      const B = await fresh("V29b");
      fake.delete(A);
      await send(A, "OUT_FOR_DELIVERY");
      const noA = (await rowsOf(A))[0].deliveryNo;
      fake.set(B, { route: route29, photos: [] });
      await send(B, "OUT_FOR_DELIVERY");
      const noB = (await rowsOf(B))[0].deliveryNo;
      fake.set(A, { route: route29, photos: [] });
      await send(A, "OUT_FOR_DELIVERY");
      assert.equal((await rowsOf(A))[0].deliveryNo, noB);
      const logs = await logsOf(A);
      assert.equal(logs[logs.length - 1].remark, `改派：从 ${noA} 转到 ${noB}`);
      assert.equal((await pm.chaipaiShipmentState.findUnique({ where: { shipmentId: A } })).deliveryNo, noB);
    });
    await test("V30 员工把自动建的派送中单删了、同一趟车又来签收 → 用回这票原来的 WD，不换新号", async () => {
      const S = await fresh("V30");
      const route30 = { ...routeA, id: `${P}routeV30` };
      fake.set(S, { route: route30, photos: [] });
      await send(S, "OUT_FOR_DELIVERY");
      const row = (await rowsOf(S))[0];
      const del = await call("DELETE /admin/lastmile/orders", { auth: STAFF, query: { id: row.id } });
      assert.equal(del.status, 200);
      fake.set(S, { route: route30, photos: [{ id: "p30", createdAt: "2026-10-12T03:00:00.000Z" }] });
      await send(S, "DELIVERED");
      const rows = await rowsOf(S);
      assert.deepEqual([rows.length, rows[0].deliveryNo, rows[0].status], [1, row.deliveryNo, "SIGNED"]);
    });
    await test("V31 要并到同车的号、可这票在那张单里已经有一行（以前那趟签收的）→ 分不清，503 交人工、一个字不写", async () => {
      const route31 = { ...routeA, id: `${P}routeV31` };
      const B = await fresh("V31b");
      fake.set(B, { route: route31, photos: [] });
      await send(B, "OUT_FOR_DELIVERY");
      const noB = (await rowsOf(B))[0].deliveryNo;
      const A = await fresh("V31a");
      await manualRow("v31", A, noB, "SIGNED");
      fake.delete(A);
      await send(A, "OUT_FOR_DELIVERY");
      fake.set(A, { route: route31, photos: [{ id: "p31", createdAt: "2026-10-12T03:00:00.000Z" }] });
      const r = await send(A, "DELIVERED");
      assert.equal(r.status, 503);
      assert.equal(await pm.chaipaiCallbackEvent.count({ where: { eventId: r.body.eventId } }), 0);
      assert.equal((await shipmentOf(A)).currentStatus, "outForDelivery");
    });
    await test("V32 同车另一票的自动单已被员工删掉 / 改派：不把那个废了的号捡回来给别的票", async () => {
      const route32 = { ...routeA, id: `${P}routeV32` };
      const B = await fresh("V32b");
      fake.set(B, { route: route32, photos: [] });
      await send(B, "OUT_FOR_DELIVERY");
      const rowB = (await rowsOf(B))[0];
      await call("DELETE /admin/lastmile/orders", { auth: STAFF, query: { id: rowB.id } });
      const A = await fresh("V32a");
      fake.set(A, { route: route32, photos: [] });
      await send(A, "OUT_FOR_DELIVERY");
      assert.notEqual((await rowsOf(A))[0].deliveryNo, rowB.deliveryNo);
    });
    await test("V33 A 出车 → 员工删了 A 的单 → B 同一趟车出车拿到号 → A 再来签收：并到 B 的号（一趟车一个号），补一条「改派」", async () => {
      const route33 = { ...routeA, id: `${P}routeV33` };
      const A = await fresh("V33a");
      fake.set(A, { route: route33, photos: [] });
      await send(A, "OUT_FOR_DELIVERY");
      const rowA = (await rowsOf(A))[0];
      await call("DELETE /admin/lastmile/orders", { auth: STAFF, query: { id: rowA.id } });
      const B = await fresh("V33b");
      fake.set(B, { route: route33, photos: [] });
      await send(B, "OUT_FOR_DELIVERY");
      const noB = (await rowsOf(B))[0].deliveryNo;
      assert.notEqual(noB, rowA.deliveryNo, "前提：A 的单删了，B 拿的是新号");
      fake.set(A, { route: route33, photos: [{ id: "p33", createdAt: "2026-10-12T03:00:00.000Z" }] });
      await send(A, "DELIVERED");
      assert.equal((await rowsOf(A))[0].deliveryNo, noB);
      // 只看拆派仓写的那几条：员工删单那条记的是真实时间，测试里回传用的是写死的 10-12 时间，日子一过它就排到最后（10-13 踩到）
      const logs = (await logsOf(A)).filter((l: Row) => l.operatorName === "拆派仓").slice(-2).map((l: Row) => l.remark);
      assert.deepEqual(logs, [`改派：从 ${rowA.deliveryNo} 转到 ${noB}`, `尾程派送已签收（${noB}）`]);
    });
    await test("V34 员工删了自动单、下一条（序号连着的）签收这回只读接口 404 → 用回原来的号、记着的趟次不清", async () => {
      const route34 = { ...routeA, id: `${P}routeV34` };
      const S = await fresh("V34");
      fake.set(S, { route: route34, photos: [] });
      await send(S, "OUT_FOR_DELIVERY");
      const row = (await rowsOf(S))[0];
      await call("DELETE /admin/lastmile/orders", { auth: STAFF, query: { id: row.id } });
      fake.delete(S);
      await send(S, "DELIVERED");
      const rows = await rowsOf(S);
      assert.deepEqual([rows.length, rows[0].deliveryNo, rows[0].status], [1, row.deliveryNo, "SIGNED"]);
      assert.equal((await pm.chaipaiShipmentState.findUnique({ where: { shipmentId: S } })).routeId, route34.id);
    });
    await test("V35 员工删了自动单（运单已退回仓）、拆派仓再说已到仓 → 状态表不再指着删掉的单和那趟车", async () => {
      const S = await fresh("V35");
      fake.set(S, { route: { ...routeA, id: `${P}routeV35` }, photos: [] });
      await send(S, "OUT_FOR_DELIVERY");
      await call("DELETE /admin/lastmile/orders", { auth: STAFF, query: { id: (await rowsOf(S))[0].id } });
      await send(S, "ARRIVED");
      const st = await pm.chaipaiShipmentState.findUnique({ where: { shipmentId: S } });
      assert.deepEqual([st.routeId, st.deliveryNo, st.lastmileOrderId], [null, null, null]);
    });
    await test("V36 同一趟车前 60 票的自动单都已作废、第 61 票的还在 → 新票照样并到那个还在的号", async () => {
      const route36 = `${P}routeV36`;
      const ids: string[] = [];
      for (let i = 0; i < 60; i++) ids.push(await fresh(`V36d${i}`));
      await pm.chaipaiShipmentState.createMany({ data: ids.map((id, i) => ({
        shipmentId: id, companyId: CO, lastSequence: 1, lastEventId: `${P}e36_${i}`, thaiStatus: "OUT_FOR_DELIVERY",
        occurredAt: new Date(), routeId: route36, deliveryNo: `WDZZ36D${i}`, lastmileOrderId: `lm_cp_dead_${i}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      })) });
      const live = await fresh("V36live");
      fake.set(live, { route: { ...routeA, id: route36 }, photos: [] });
      await send(live, "OUT_FOR_DELIVERY");
      const liveNo = (await rowsOf(live))[0].deliveryNo;
      assert.ok(!liveNo.startsWith("WDZZ36D"), "不能捡死号");
      const S = await fresh("V36new");
      fake.set(S, { route: { ...routeA, id: route36 }, photos: [] });
      await send(S, "OUT_FOR_DELIVERY");
      assert.equal((await rowsOf(S))[0].deliveryNo, liveNo);
    });
    await test("V37 同一趟车：A 先被拉回仓（系统撤了单）、B 的派送中晚到 → B 照样用这趟车原来的号（没有员工动手）", async () => {
      const route37 = { ...routeA, id: `${P}routeV37` };
      const A = await fresh("V37a");
      const B = await fresh("V37b");
      fake.set(A, { route: route37, photos: [] });
      await send(A, "OUT_FOR_DELIVERY");
      const noA = (await rowsOf(A))[0].deliveryNo;
      fake.set(B, { status: 503 });
      const late = await send(B, "OUT_FOR_DELIVERY");
      assert.equal(late.status, 503, "前提：B 这条先没办成");
      await send(A, "ARRIVED");
      assert.equal((await rowsOf(A)).length, 0, "前提：A 的单被系统撤了");
      fake.set(B, { route: route37, photos: [] });
      const again = await call("POST /integrations/chaipai/v2/events", { body: late.body, authorization: `Bearer ${CB}` });
      assert.equal(again.raw.result, "APPLIED");
      assert.equal((await rowsOf(B))[0].deliveryNo, noA);
    });
    await test("V38 A 在 R 车被拉回仓、又上 S 车再被拉回仓，B 在 R 车的派送中最后才到 → B 还是 R 车原来的号（记号不互相覆盖）", async () => {
      const routeR = { ...routeA, id: `${P}routeV38R` };
      const routeS = { ...routeA, id: `${P}routeV38S` };
      const A = await fresh("V38a");
      const B = await fresh("V38b");
      fake.set(A, { route: routeR, photos: [] });
      await send(A, "OUT_FOR_DELIVERY");
      const noR = (await rowsOf(A))[0].deliveryNo;
      fake.set(B, { status: 503 });
      const late = await send(B, "OUT_FOR_DELIVERY");
      assert.equal(late.status, 503);
      await send(A, "ARRIVED");
      fake.set(A, { route: routeS, photos: [] });
      await send(A, "OUT_FOR_DELIVERY");
      const noS = (await rowsOf(A))[0].deliveryNo;
      assert.notEqual(noS, noR);
      await send(A, "ARRIVED");
      fake.set(B, { route: routeR, photos: [] });
      const again = await call("POST /integrations/chaipai/v2/events", { body: late.body, authorization: `Bearer ${CB}` });
      assert.equal(again.raw.result, "APPLIED");
      assert.equal((await rowsOf(B))[0].deliveryNo, noR);
    });
    await test("V19 一票同时挂两张派送中的单（老数据）：派送中 / 已签收都 503、一个字不写，交人工", async () => {
      const S19 = await fresh("V19", "outForDelivery");
      await manualRow("v19a", S19, "WDZZV19A", "DELIVERING");
      await manualRow("v19b", S19, "WDZZV19B", "DELIVERING");
      fake.set(S19, { route: { ...routeA, id: `${P}routeV19` }, photos: [{ id: "p19", createdAt: "2026-10-12T03:00:00.000Z" }] });
      for (const st of ["OUT_FOR_DELIVERY", "DELIVERED"]) {
        const r = await send(S19, st);
        assert.equal(r.status, 503, st);
        assert.equal(await pm.chaipaiCallbackEvent.count({ where: { eventId: r.body.eventId } }), 0);
      }
      assert.deepEqual([(await shipmentOf(S19)).currentStatus, (await rowsOf(S19)).map((r: Row) => r.status)], ["outForDelivery", ["DELIVERING", "DELIVERING"]]);
    });
    await test("V20 拉清单真的拿同柜排队锁：别人拿着这把锁时，拉清单要等它放开（删了那句锁这项就红）", async () => {
      const ctn = await pm.container.findFirst({ where: { containerNo: ctnNo }, select: { id: true } });
      let released = 0;
      let gotLock!: () => void;
      const locked = new Promise<void>((r) => { gotLock = r; });
      const holder = pm.$transaction(async (tx: any) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(83060, hashtext(${ctn.id}))`;
        gotLock(); // 真拿到锁了才放拉清单出发（不靠猜时间）
        await new Promise((r) => setTimeout(r, 1500));
        released = Date.now();
      }, { timeout: 10000 });
      await locked;
      const r = await pull(ctnNo);
      const doneAt = Date.now();
      await holder;
      assert.equal(r.status, 200);
      assert.ok(released > 0 && doneAt >= released, "拉清单没等那把锁就回来了");
    });
    await test("V21 照片多、拆派仓每页慢：在时间预算里翻完就照常签收；翻不完按时回 503（不拖过 10 秒）", async () => {
      const S21 = await fresh("V21");
      const photos = Array.from({ length: 250 }, (_, i) => ({ id: `w${String(i).padStart(3, "0")}`, createdAt: new Date(Date.UTC(2026, 9, 12, 1, 0, i)).toISOString() }));
      fake.set(S21, { route: routeA, photos, pageDelayMs: 300 });
      const ok = await send(S21, "DELIVERED");
      assert.equal(ok.raw.result, "APPLIED");
      // 翻页把时间用掉大半、取照片又卡住：照样在 10 秒内回 503、一个字不写
      const S21c = await fresh("V21c");
      const slowPhotos = photos.map((p) => ({ ...p, delayMs: 6000 }));
      fake.set(S21c, { route: routeA, photos: slowPhotos, pageDelayMs: 400 });
      const t1 = Date.now();
      const blocked = await send(S21c, "DELIVERED");
      assert.equal(blocked.status, 503);
      assert.ok(Date.now() - t1 < 10000, `详情 + 照片拖了 ${Date.now() - t1}ms`);
      assert.equal((await rowsOf(S21c)).length, 0);
      const S21b = await fresh("V21b");
      fake.set(S21b, { route: routeA, photos, pageDelayMs: 900 });
      const t0 = Date.now();
      const slow = await send(S21b, "DELIVERED");
      assert.equal(slow.status, 503);
      assert.ok(Date.now() - t0 < 10000, `拖了 ${Date.now() - t0}ms`);
      assert.equal((await rowsOf(S21b)).length, 0);
    });
    await test("V14 走真的 HTTP 服务（createApp）：回传带 JSON 正文 → 裸 JSON 回复；清单也是裸 JSON；不带密钥 401", async () => {
      const { createApp } = await import("../apps/api/src/server");
      const net = await import("node:net");
      const port: number = await new Promise((resolve) => { const srv = net.createServer(); srv.listen(0, "127.0.0.1", () => { const p2 = (srv.address() as AddressInfo).port; srv.close(() => resolve(p2)); }); });
      process.env.BIND_HOST = "127.0.0.1";
      const real = createApp();
      (await import("../apps/api/src/modules/chaipai/routes")).registerChaipaiRoutes(real);
      await new Promise<void>((resolve) => real.listen(port, () => resolve()));
      const base = `http://127.0.0.1:${port}`;
      const SH = await fresh("HTTP");
      const body = { eventId: `${P}http1`, protocolVersion: 2, companyId: "xiangtai", sourceShipmentId: SH, sequence: 1, status: "ARRIVED", occurredAt: "2026-10-12T03:00:00.000Z" };
      const r1 = await fetch(`${base}/integrations/chaipai/v2/events`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${CB}` }, body: JSON.stringify(body) });
      assert.deepEqual([r1.status, await r1.json()], [200, { eventId: `${P}http1`, result: "APPLIED" }]);
      const r2 = await fetch(`${base}/integrations/chaipai/v2/container-manifest?containerNo=${encodeURIComponent(ctnNo.toLowerCase())}`, { headers: { authorization: `Bearer ${PULL}` } });
      const j2 = await r2.json();
      assert.deepEqual([r2.status, j2.protocolVersion, "code" in j2], [200, 2, false]);
      const r3 = await fetch(`${base}/integrations/chaipai/v2/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(r3.status, 401);
      // 按运单号取票（10-13）：不走登录解析也能进、裸 JSON、顶层 waybillNo 原样回（带空格）；不带密钥 401
      const wb = ` ${parentNo}-1 `;
      const r4 = await fetch(`${base}/integrations/chaipai/v2/waybill-manifest?waybillNo=${encodeURIComponent(wb)}`, { headers: { authorization: `Bearer ${PULL}` } });
      const j4 = await r4.json();
      assert.deepEqual([r4.status, "code" in j4, j4.waybillNo, j4.manifests[0].shipments[0].waybillNo], [200, false, wb, `${parentNo}-1`]);
      const r5 = await fetch(`${base}/integrations/chaipai/v2/waybill-manifest?waybillNo=${encodeURIComponent(wb)}`);
      assert.equal(r5.status, 401);
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
  // 真 HTTP 那项起的服务没有关的口子，这里直接结束
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
