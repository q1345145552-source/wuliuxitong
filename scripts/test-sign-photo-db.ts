/**
 * 2026-10-23 安全审查 S3：签收必须有照片 —— 真库 + 真路由（/admin/lastmile/status、/admin/lastmile/unsign、/admin/containers/status、
 * /staff/loading-manifests/add-shipment）。
 *
 * 原来：页面上不选照片点不了签收，后端却不查 —— 员工直接调接口，不传照片也能签成「已签收」；
 *       传个「A」也照存，签收凭证打不开。复核又查出一条：装柜管理的推柜子接口能直接推到「已签收」，整柜货变已送达、一张照片都没有。
 * 现在：
 *   P1 从没签收 → 签收，必须带照片；不带 400，什么都不动
 *   P2 带的东西不是图（「A」、普通文字、带 data: 前缀、只凑对开头几个字节、不是字符串、超大）一律 400，什么都不动
 *   P3 认得出的图（jpg / png / gif / webp 文件头）照常签收：派送单已签收、照片原样存、运单已送达、轨迹一条
 *   P4 已签收的再交一张更清楚的照片照旧能换（原有用法），不带照片什么都不改，乱传 400 且旧照片不丢
 *   P5 撤销误签收后再签：照片虽然还留着，也要重新带；带了照常签回去
 *   P6 改成派送中（不签收）不要求照片，但带了乱的照样挡
 *   P7 撤销误签收正在提交时同时来一个不带照片的签收：按锁后的状态（派送中）判，挡住
 *   P8 走真 HTTP 服务（createApp）：不带照片 400 VALIDATION_ERROR、数据不动；带照片 200
 *   P9 推柜子不许推到「派送中 / 已签收」（400、柜子和货都不动；从预约派送推、老柜同状态重推也挡）；正常往下推照旧
 *   P10 停在「派送中 / 已签收」的柜子不许再装货（原来新货会补轨迹补到已送达，Codex / dsh 第 2 轮）；刚到仓的柜子照常能装
 *
 * 只连一次性库：DATABASE_URL 不是 Neon 时要 AGENT_PORTAL_TEST_ALLOW_DB=1。测试数据前缀 zz_sgp_，跑完清到 0。
 */
process.env.TZ = process.env.TZ || "UTC";
process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-only-secret-for-this-script";
import assert from "node:assert/strict";
import net from "node:net";
import type { AddressInfo } from "node:net";

type Auth = { userId: string; companyId: string; role: "admin" | "staff" | "client"; name: string };
type Row = Record<string, any>;

const CO = "zz_sgp_co";
const ADMIN: Auth = { userId: "zz_sgp_admin", companyId: CO, role: "admin", name: "签收超管" };
const STAFF: Auth = { userId: "zz_sgp_staff", companyId: CO, role: "staff", name: "签收员工" };
const CLIENT = "ZZSGPC1";

const pad = (head: Buffer) => Buffer.concat([head, Buffer.alloc(24, 7)]).toString("base64");
const JPG = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
const JPG_EXIF = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe1])); // 手机相机拍的大多是这种
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const GIF = pad(Buffer.from("GIF89a"));
const GIF87 = pad(Buffer.from("GIF87a"));
const webp = (chunk: string) => pad(Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x20, 0, 0, 0]), Buffer.from(`WEBP${chunk}`)]));
const WEBP = webp("VP8 ");

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => { const p = (srv.address() as AddressInfo).port; srv.close(() => resolve(p)); });
  });
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url || url.includes("blocked")) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (!url.includes("neon.tech") && process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：DATABASE_URL 不是 Neon 测试库，怕连到生产库不跑（确认是测试库可设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  process.env.BIND_HOST = "127.0.0.1";
  const { prisma } = await import("../apps/api/src/db/prisma");
  const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
  const { UPLOAD_IMAGE_MAX_BASE64 } = await import("../apps/api/src/modules/core/upload-limit");
  const { signAuthToken } = await import("../apps/api/src/modules/auth/token");
  const { createApp } = await import("../apps/api/src/server");
  const adminOps = await import("../apps/api/src/modules/admin-ops/routes");
  const containers = await import("../apps/api/src/modules/containers/routes");
  const manifests = await import("../apps/api/src/modules/loading-manifests/routes");
  const pm: any = prisma;

  const routes = new Map<string, Function>();
  const app: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) app[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
  adminOps.registerAdminOpsRoutes(app);
  containers.registerContainerRoutes(app);
  manifests.registerLoadingManifestRoutes(app);

  async function call(key: string, auth: Auth, body: Row = {}, query: Record<string, string> = {}): Promise<{ status: number; data: any; message: string }> {
    const handler = routes.get(key);
    if (!handler) return { status: 404, data: undefined, message: `没有这个接口：${key}` };
    let status = 200; let raw: any;
    const res: any = { status(s: number) { status = s; return res; }, json(p: any) { raw = p; }, setHeader() {} };
    try { await handler({ body, query, headers: {}, auth: { agentId: null, ...auth } }, res); }
    catch (e) {
      if (e instanceof BusinessError) { status = e.httpStatus; raw = { code: e.code, message: e.message }; }
      else { status = 500; raw = { message: `【未翻成业务错误的异常】${(e as Error)?.message ?? e}` }; }
    }
    return { status, data: raw?.data, message: raw?.message ?? "" };
  }
  const sign = (id: string, signImageBase64?: unknown, auth: Auth = STAFF) =>
    call("POST /admin/lastmile/status", auth, signImageBase64 === undefined ? { id, status: "SIGNED" } : { id, status: "SIGNED", signImageBase64 });

  async function cleanup(): Promise<void> {
    const cs = await pm.container.findMany({ where: { companyId: CO }, select: { id: true } });
    await pm.shipmentContainerItem.deleteMany({ where: { containerId: { in: cs.map((c: Row) => c.id) } } });
    if (pm.containerPushEntry) await pm.containerPushEntry.deleteMany({ where: { companyId: CO } });
    if (pm.containerPushBatch) await pm.containerPushBatch.deleteMany({ where: { companyId: CO } });
    await pm.container.deleteMany({ where: { companyId: CO } });
    await pm.adminLastmileOrder.deleteMany({ where: { companyId: CO } });
    await pm.statusLog.deleteMany({ where: { companyId: CO } });
    await pm.shipment.deleteMany({ where: { companyId: CO } });
    await pm.order.deleteMany({ where: { companyId: CO } });
    await pm.auditLog.deleteMany({ where: { companyId: CO } });
    await pm.user.deleteMany({ where: { companyId: CO } });
  }

  let seq = 0;
  /** 一张订单 + 一票运单（默认派送中）；返回运单 id */
  async function seedShipment(currentStatus = "outForDelivery"): Promise<string> {
    seq += 1;
    const o = `zz_sgp_o${seq}`; const s = `zz_sgp_s${seq}`;
    await pm.order.create({ data: {
      id: o, companyId: CO, clientId: CLIENT, warehouseId: "wh_yiwu_01", itemName: "鞋", productQuantity: 0, packageCount: 1, packageUnit: "box",
      transportMode: "sea", weightKg: 1, volumeM3: 0.1, approvalStatus: "approved", receiverNameTh: "r", receiverPhoneTh: "0", receiverAddressTh: "曼谷",
    } });
    await pm.shipment.create({ data: {
      id: s, companyId: CO, orderId: o, trackingNo: `ZZSGP${seq}`, currentStatus, warehouseId: "wh_yiwu_01", transportMode: "sea", packageCount: 1, weightKg: 1, volumeM3: 0.1,
    } });
    return s;
  }
  /** 一票派送中的货 + 一张派送中的派送单，返回派送单 id、运单 id */
  async function seed(): Promise<{ lm: string; ship: string }> {
    const ship = await seedShipment();
    const lm = `zz_sgp_lm${seq}`;
    await pm.adminLastmileOrder.create({ data: { id: lm, companyId: CO, deliveryNo: `ZZSGPD${seq}`, shipmentId: ship, carrierName: "车队", externalTrackingNo: "X", status: "DELIVERING" } });
    return { lm, ship };
  }
  /** 派送单 + 运单 + 轨迹条数的快照：挡住的请求前后必须一模一样 */
  async function snap(ids: { lm: string; ship: string }): Promise<Row> {
    const lm = await pm.adminLastmileOrder.findUnique({ where: { id: ids.lm }, select: { status: true, signImageBase64: true } });
    const sh = await pm.shipment.findUnique({ where: { id: ids.ship }, select: { currentStatus: true } });
    return { ...lm, ship: sh.currentStatus, logs: await pm.statusLog.count({ where: { shipmentId: ids.ship } }) };
  }

  let passed = 0, failed = 0;
  async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`✅ ${name}`); }
    catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
  }

  console.log("签收照片（真库 + 真路由）");
  await cleanup();
  try {
    for (const u of [ADMIN, STAFF]) await pm.user.create({ data: { id: u.userId, companyId: CO, role: u.role, name: u.name, passwordHash: "x", phone: "000", status: "active" } });
    await pm.user.create({ data: { id: CLIENT, companyId: CO, role: "client", name: "签收客户", passwordHash: "x", phone: "000", status: "active" } });

    await check("P1 员工第一次签收不带照片（不传 / 空字符串 / null）：400「签收要上传签收照片」，派送单、运单、轨迹一样不动", async () => {
      const ids = await seed();
      const before = await snap(ids);
      for (const img of [undefined, "", null]) {
        const r = await sign(ids.lm, img);
        assert.equal(r.status, 400, `照片=${JSON.stringify(img)} 居然签成了（${r.status}）`);
        assert.equal(r.message, "签收要上传签收照片");
        assert.deepEqual(await snap(ids), before);
      }
    });

    await check("P2 带的不是图（A / 文字 / data: 前缀 / 只凑对开头几个字节 / 数字 / 对象 / 超大）：一律 400，什么都不动", async () => {
      const ids = await seed();
      const before = await snap(ids);
      const bad: Array<[string, unknown]> = [
        ["A", "A"], ["proof", "proof"], ["普通文字", Buffer.from("hello, this is not an image").toString("base64")],
        ["data: 前缀", `data:image/png;base64,${PNG}`], ["png 中间夹空格", `${PNG.slice(0, 8)} ${PNG.slice(8)}`],
        // Codex 10-23 复核：原来 PNG 只比 4 个字节、GIF 只比 GIF8，开头凑对就能混过去
        ["只有 PNG 前 4 个字节", pad(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("not a png at all")]))],
        ["GIF8 开头的乱码", pad(Buffer.from("GIF8definitely not gif"))],
        ["RIFF…WEBP 后面不是 VP", pad(Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBPxx")]))],
        ["数字", 12345], ["对象", { a: 1 }], ["数组", [PNG]],
      ];
      for (const [name, img] of bad) {
        const r = await sign(ids.lm, img);
        assert.equal(r.status, 400, `「${name}」没挡住（${r.status}）`);
        assert.match(r.message, /签收照片不对/, `「${name}」提示不对：${r.message}`);
        assert.deepEqual(await snap(ids), before, `「${name}」动了数据`);
      }
      const huge = await sign(ids.lm, "/9j/" + "A".repeat(UPLOAD_IMAGE_MAX_BASE64));
      assert.equal(huge.status, 400, "超大的没挡住");
      assert.match(huge.message, /MB/, `超大的提示不对：${huge.message}`);
      assert.deepEqual(await snap(ids), before);
    });

    await check("P3 认得出文件头的图（jpg 两种 / png / gif 两种 / webp 三种）照常签收：派送单已签收、照片原样存、运单已送达、轨迹多一条", async () => {
      const ok: Array<[string, string]> = [["jpg", JPG], ["jpg EXIF", JPG_EXIF], ["png", PNG], ["gif89a", GIF], ["gif87a", GIF87],
        ["webp VP8", WEBP], ["webp VP8L", webp("VP8L")], ["webp VP8X", webp("VP8X")]];
      for (const [name, img] of ok) {
        const ids = await seed();
        const r = await sign(ids.lm, img);
        assert.equal(r.status, 200, `${name} 签不了：${r.message}`);
        assert.deepEqual(await snap(ids), { status: "SIGNED", signImageBase64: img, ship: "delivered", logs: 1 }, name);
      }
    });

    await check("P4 已签收：换一张照片照旧能换、轨迹不加；不带照片 200、状态 / 照片 / 运单 / 轨迹都不变；乱传 400 旧照片不丢", async () => {
      const ids = await seed();
      assert.equal((await sign(ids.lm, JPG)).status, 200);
      const r1 = await sign(ids.lm, PNG);
      assert.equal(r1.status, 200, r1.message);
      assert.deepEqual(await snap(ids), { status: "SIGNED", signImageBase64: PNG, ship: "delivered", logs: 1 });
      const r2 = await sign(ids.lm);
      assert.equal(r2.status, 200, r2.message);
      assert.deepEqual(await snap(ids), { status: "SIGNED", signImageBase64: PNG, ship: "delivered", logs: 1 });
      const r3 = await sign(ids.lm, "A");
      assert.equal(r3.status, 400);
      assert.deepEqual(await snap(ids), { status: "SIGNED", signImageBase64: PNG, ship: "delivered", logs: 1 });
    });

    await check("P5 撤销误签收后再签：不带照片 400（虽然旧照片还在）；带新照片照常签回去、照片换成新的", async () => {
      const ids = await seed();
      assert.equal((await sign(ids.lm, JPG)).status, 200);
      const un = await call("POST /admin/lastmile/unsign", ADMIN, { id: ids.lm });
      assert.equal(un.status, 200, un.message);
      const mid = await snap(ids);
      assert.equal(mid.status, "DELIVERING");
      assert.equal(mid.signImageBase64, JPG, "撤销签收把照片删了（原来的规矩是保留）");
      const r1 = await sign(ids.lm);
      assert.equal(r1.status, 400, `撤销后不带照片又签成了（${r1.status}）`);
      assert.deepEqual(await snap(ids), mid);
      const r2 = await sign(ids.lm, WEBP);
      assert.equal(r2.status, 200, r2.message);
      const end = await snap(ids);
      assert.equal(end.status, "SIGNED");
      assert.equal(end.signImageBase64, WEBP);
      assert.equal(end.ship, "delivered");
    });

    await check("P6 改成派送中不要求照片（200）；带了乱的照样 400", async () => {
      const ids = await seed();
      const r1 = await call("POST /admin/lastmile/status", STAFF, { id: ids.lm, status: "DELIVERING" });
      assert.equal(r1.status, 200, r1.message);
      const before = await snap(ids);
      const r2 = await call("POST /admin/lastmile/status", STAFF, { id: ids.lm, status: "DELIVERING", signImageBase64: "A" });
      assert.equal(r2.status, 400);
      assert.deepEqual(await snap(ids), before);
    });

    // 撤销那一边用手工事务模拟（锁派送单 → 改回派送中 → 先不提交），只测签收这一侧是不是按锁后的状态判
    await check("P7 撤销误签收正在提交时，同时来一个不带照片的签收：等锁放开后按「派送中」判，400、不会悄悄签回去", async () => {
      const ids = await seed();
      assert.equal((await sign(ids.lm, JPG)).status, 200);
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let locked!: () => void;
      const lockedNow = new Promise<void>((r) => { locked = r; });
      // 模拟撤销那一边：锁住派送单、改回派送中，先不提交
      const holder = pm.$transaction(async (tx: any) => {
        await tx.$queryRaw`SELECT id FROM admin_lastmile_orders WHERE id = ${ids.lm} FOR UPDATE`;
        await tx.adminLastmileOrder.update({ where: { id: ids.lm }, data: { status: "DELIVERING" } });
        locked();
        await gate;
      }, { timeout: 30_000, maxWait: 10_000 });
      await lockedNow;
      const pending = sign(ids.lm);
      // 确认签收那一边真的卡在锁上了，才放开（不然测的是先后两次、不是同时）。
      // 最多等 2 秒：签收那边的事务默认 5 秒超时，等太久它会自己超时变 500（dsh 第 2 轮）；不管中间出什么错都放锁（Codex 第 2 轮）
      let waiting = 0;
      try {
        for (let i = 0; i < 40 && !waiting; i += 1) {
          const rows: Array<{ n: number }> = await pm.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query ILIKE '%admin_lastmile_orders%FOR UPDATE%'`;
          waiting = rows[0]?.n ?? 0;
          if (!waiting) await new Promise((r) => setTimeout(r, 50));
        }
      } finally {
        release();
        await holder;
      }
      const r = await pending;
      assert.equal(waiting, 1, "签收请求没卡在锁上，这一项没测到并发");
      assert.equal(r.status, 400, `锁放开后不带照片签回去了（${r.status}）：${r.message}`);
      const end = await snap(ids);
      assert.equal(end.status, "DELIVERING");
    });

    await check("P8 走真 HTTP 服务：不带照片 400 VALIDATION_ERROR、数据不动；带照片 200", async () => {
      const real = createApp();
      adminOps.registerAdminOpsRoutes(real);
      const port = await freePort();
      await new Promise<void>((resolve) => real.listen(port, () => resolve()));
      const token = signAuthToken({ userId: STAFF.userId, companyId: CO, role: "staff", userName: STAFF.name, passwordHash: "x", expiresInSeconds: 600 });
      const post = async (body: Row) => {
        const r = await fetch(`http://127.0.0.1:${port}/admin/lastmile/status`, {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
        });
        return { status: r.status, body: await r.json() as Row };
      };
      const ids = await seed();
      const before = await snap(ids);
      const r1 = await post({ id: ids.lm, status: "SIGNED" });
      assert.deepEqual([r1.status, r1.body.code, r1.body.message], [400, "VALIDATION_ERROR", "签收要上传签收照片"]);
      assert.deepEqual(await snap(ids), before);
      const r2 = await post({ id: ids.lm, status: "SIGNED", signImageBase64: "A" });
      assert.equal(r2.status, 400);
      const r3 = await post({ id: ids.lm, status: "SIGNED", signImageBase64: PNG });
      assert.equal(r3.status, 200, JSON.stringify(r3.body));
      assert.equal((await snap(ids)).status, "SIGNED");
    });

    await check("P9 推柜子到「派送中 / 已签收」400，柜子和柜里的货都不动；正常推到预约派送照旧", async () => {
      const ship = await seedShipment("inWarehouseTH");
      const box = await pm.container.create({ data: { companyId: CO, containerNo: `ZZSGPCTN${seq}`, containerType: "40HQ", transportMode: "sea", currentStatus: "IN_WAREHOUSE_TH" } });
      await pm.shipmentContainerItem.create({ data: { containerId: box.id, shipmentId: ship, loadedPieceCount: 1, loadedVolumeM3: 0.1 } });
      const state = async () => ({
        box: (await pm.container.findUnique({ where: { id: box.id }, select: { currentStatus: true } })).currentStatus,
        ship: (await pm.shipment.findUnique({ where: { id: ship }, select: { currentStatus: true } })).currentStatus,
        logs: await pm.statusLog.count({ where: { shipmentId: ship } }),
      });
      const before = await state();
      for (const auth of [STAFF, ADMIN]) {
        for (const toStatus of ["SIGNED", "OUT_FOR_DELIVERY"]) {
          const r = await call("POST /admin/containers/status", auth, { id: box.id, toStatus });
          assert.equal(r.status, 400, `${auth.role} 推到 ${toStatus} 没挡住（${r.status}）`);
          assert.match(r.message, /尾端派送/, r.message);
          assert.deepEqual(await state(), before, `${auth.role} 推到 ${toStatus} 动了数据`);
        }
      }
      const ok = await call("POST /admin/containers/status", STAFF, { id: box.id, toStatus: "DELIVERY_BOOKED" });
      assert.equal(ok.status, 200, ok.message);
      assert.deepEqual(await state(), { box: "DELIVERY_BOOKED", ship: "deliveryBooked", logs: 1 });
      // 预约派送是装柜页能推的最后一步，从这里往下推同样挡
      const atBooked = await state();
      for (const toStatus of ["OUT_FOR_DELIVERY", "SIGNED"]) {
        const r = await call("POST /admin/containers/status", ADMIN, { id: box.id, toStatus });
        assert.equal(r.status, 400, `从预约派送推到 ${toStatus} 没挡住（${r.status}）`);
        assert.deepEqual(await state(), atBooked);
      }
      // 线上那 3 个 6 月以前的老柜就停在「已签收」：同状态重推（续写）也挡，不会再给柜里的货写一遍已签收
      await pm.container.update({ where: { id: box.id }, data: { currentStatus: "SIGNED" } });
      const again = await call("POST /admin/containers/status", ADMIN, { id: box.id, toStatus: "SIGNED" });
      assert.equal(again.status, 400, `老柜同状态重推没挡住（${again.status}）`);
      assert.deepEqual(await state(), { ...atBooked, box: "SIGNED" });
    });

    await check("P10 停在「已签收 / 派送中」的柜子不许再装货（400，货、柜子、轨迹都不动）；刚到仓的柜子照常能装", async () => {
      const box = async (currentStatus: string) => pm.container.create({ data: {
        companyId: CO, containerNo: `ZZSGPLM${++seq}`, containerType: "40HQ", transportMode: "sea", currentStatus, warehouseId: "wh_yiwu_01",
        statusDates: JSON.stringify({ SEALED: "2026-09-01T00:00:00.000Z", IN_TRANSIT: "2026-09-03T00:00:00.000Z", ARRIVED: "2026-09-12T00:00:00.000Z", [currentStatus]: "2026-09-20T00:00:00.000Z" }),
      } });
      const ship = await seedShipment("inWarehouseCN");
      const trackingNo = (await pm.shipment.findUnique({ where: { id: ship }, select: { trackingNo: true } })).trackingNo;
      const state = async () => ({
        ships: await pm.shipment.count({ where: { companyId: CO, OR: [{ id: ship }, { parentTrackingNo: trackingNo }] } }),
        status: (await pm.shipment.findUnique({ where: { id: ship }, select: { currentStatus: true } })).currentStatus,
        items: await pm.shipmentContainerItem.count({ where: { shipmentId: ship } }),
        logs: await pm.statusLog.count({ where: { companyId: CO } }),
      });
      const before = await state();
      for (const st of ["SIGNED", "OUT_FOR_DELIVERY"]) {
        const b = await box(st);
        const r = await call("POST /staff/loading-manifests/add-shipment", STAFF, { trackingNo }, { id: b.id });
        assert.equal(r.status, 400, `往「${st}」的柜子加货没挡住（${r.status}）`);
        assert.match(r.message, /不能再往里装货/, r.message);
        assert.deepEqual(await state(), before, `往「${st}」的柜子加货动了数据`);
        assert.equal((await pm.container.findUnique({ where: { id: b.id }, select: { currentStatus: true } })).currentStatus, st);
      }
      const okBox = await box("IN_WAREHOUSE_TH");
      const ok = await call("POST /staff/loading-manifests/add-shipment", STAFF, { trackingNo }, { id: okBox.id });
      assert.equal(ok.status, 200, ok.message);
      const child = await pm.shipment.findFirst({ where: { companyId: CO, parentTrackingNo: trackingNo }, select: { currentStatus: true } });
      assert.equal(child?.currentStatus, "inWarehouseTH", `装进刚到仓的柜子后子单状态不对：${child?.currentStatus}`);
    });
  } finally {
    await cleanup();
    const left = (await pm.adminLastmileOrder.count({ where: { companyId: CO } })) + (await pm.shipment.count({ where: { companyId: CO } }))
      + (await pm.statusLog.count({ where: { companyId: CO } })) + (await pm.user.count({ where: { companyId: CO } }))
      + (await pm.container.count({ where: { companyId: CO } }));
    if (left) { failed++; console.log(`❌ 测试数据没清干净：还剩 ${left} 行`); }
    await prisma.$disconnect();
  }
  console.log(`\n签收照片：通过 ${passed}，不通过 ${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
