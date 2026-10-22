/**
 * 2026-10-23 安全审查 S3：尾程派送签收照片 —— 真库 + 真路由（/admin/lastmile/status、/admin/lastmile/unsign）。
 *
 * 原来：页面上不选照片点不了签收，后端却不查 —— 员工直接调接口，不传照片也能签成「已签收」；
 *       传个「A」也照存，签收凭证打不开。
 * 现在：
 *   P1 从没签收 → 签收，必须带照片；不带 400，什么都不动
 *   P2 带的东西不是图（「A」、普通文字、带 data: 前缀、不是字符串、超大）一律 400，什么都不动
 *   P3 真图（jpg / png / gif / webp）照常签收：派送单已签收、照片原样存、运单已送达、轨迹一条
 *   P4 已签收的再交一张更清楚的照片照旧能换（原有用法），不带照片什么都不改，乱传 400 且旧照片不丢
 *   P5 撤销误签收后再签：照片虽然还留着，也要重新带；带了照常签回去
 *   P6 改成派送中（不签收）不要求照片，但带了乱的照样挡
 *
 * 只连一次性库：DATABASE_URL 不是 Neon 时要 AGENT_PORTAL_TEST_ALLOW_DB=1。测试数据前缀 zz_sgp_，跑完清到 0。
 */
process.env.TZ = process.env.TZ || "UTC";
import assert from "node:assert/strict";

type Auth = { userId: string; companyId: string; role: "admin" | "staff" | "client"; name: string };
type Row = Record<string, any>;

const CO = "zz_sgp_co";
const ADMIN: Auth = { userId: "zz_sgp_admin", companyId: CO, role: "admin", name: "签收超管" };
const STAFF: Auth = { userId: "zz_sgp_staff", companyId: CO, role: "staff", name: "签收员工" };
const CLIENT = "ZZSGPC1";

const b64 = (bytes: number[]) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(24, 7)]).toString("base64");
const JPG = b64([0xff, 0xd8, 0xff, 0xe0]);
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(24, 1)]).toString("base64");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(20, 2)]).toString("base64");

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url || url.includes("blocked")) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (!url.includes("neon.tech") && process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：DATABASE_URL 不是 Neon 测试库，怕连到生产库不跑（确认是测试库可设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  const { prisma } = await import("../apps/api/src/db/prisma");
  const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
  const { UPLOAD_IMAGE_MAX_BASE64 } = await import("../apps/api/src/modules/core/upload-limit");
  const pm: any = prisma;

  const routes = new Map<string, Function>();
  const app: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) app[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
  (await import("../apps/api/src/modules/admin-ops/routes")).registerAdminOpsRoutes(app);

  async function call(key: string, auth: Auth, body: Row = {}): Promise<{ status: number; data: any; message: string }> {
    const handler = routes.get(key);
    if (!handler) return { status: 404, data: undefined, message: `没有这个接口：${key}` };
    let status = 200; let raw: any;
    const res: any = { status(s: number) { status = s; return res; }, json(p: any) { raw = p; }, setHeader() {} };
    try { await handler({ body, query: {}, headers: {}, auth: { agentId: null, ...auth } }, res); }
    catch (e) {
      if (e instanceof BusinessError) { status = e.httpStatus; raw = { code: e.code, message: e.message }; }
      else { status = 500; raw = { message: `【未翻成业务错误的异常】${(e as Error)?.message ?? e}` }; }
    }
    return { status, data: raw?.data, message: raw?.message ?? "" };
  }
  const sign = (id: string, signImageBase64?: unknown, auth: Auth = STAFF) =>
    call("POST /admin/lastmile/status", auth, signImageBase64 === undefined ? { id, status: "SIGNED" } : { id, status: "SIGNED", signImageBase64 });

  async function cleanup(): Promise<void> {
    await pm.adminLastmileOrder.deleteMany({ where: { companyId: CO } });
    await pm.statusLog.deleteMany({ where: { companyId: CO } });
    await pm.shipment.deleteMany({ where: { companyId: CO } });
    await pm.order.deleteMany({ where: { companyId: CO } });
    await pm.auditLog.deleteMany({ where: { companyId: CO } });
    await pm.user.deleteMany({ where: { companyId: CO } });
  }

  let seq = 0;
  /** 一票派送中的货 + 一张派送中的派送单，返回派送单 id、运单 id */
  async function seed(): Promise<{ lm: string; ship: string }> {
    seq += 1;
    const o = `zz_sgp_o${seq}`; const s = `zz_sgp_s${seq}`; const lm = `zz_sgp_lm${seq}`;
    await pm.order.create({ data: {
      id: o, companyId: CO, clientId: CLIENT, warehouseId: "wh_yiwu_01", itemName: "鞋", productQuantity: 0, packageCount: 1, packageUnit: "box",
      transportMode: "sea", weightKg: 1, volumeM3: 0.1, approvalStatus: "approved", receiverNameTh: "r", receiverPhoneTh: "0", receiverAddressTh: "曼谷",
    } });
    await pm.shipment.create({ data: {
      id: s, companyId: CO, orderId: o, trackingNo: `ZZSGP${seq}`, currentStatus: "outForDelivery", warehouseId: "wh_yiwu_01", transportMode: "sea", packageCount: 1, weightKg: 1, volumeM3: 0.1,
    } });
    await pm.adminLastmileOrder.create({ data: { id: lm, companyId: CO, deliveryNo: `ZZSGPD${seq}`, shipmentId: s, carrierName: "车队", externalTrackingNo: "X", status: "DELIVERING" } });
    return { lm, ship: s };
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

    await check("P2 带的不是图（A / proof / 普通文字的 base64 / 带 data: 前缀 / 数字 / 对象 / 超大）：一律 400，什么都不动", async () => {
      const ids = await seed();
      const before = await snap(ids);
      const bad: Array<[string, unknown]> = [
        ["A", "A"], ["proof", "proof"], ["普通文字", Buffer.from("hello, this is not an image").toString("base64")],
        ["data: 前缀", `data:image/png;base64,${PNG}`], ["png 中间夹空格", `${PNG.slice(0, 8)} ${PNG.slice(8)}`],
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

    await check("P3 真图（jpg / png / gif / webp）照常签收：派送单已签收、照片原样存、运单已送达、轨迹多一条", async () => {
      for (const [name, img] of [["jpg", JPG], ["png", PNG], ["gif", GIF], ["webp", WEBP]] as const) {
        const ids = await seed();
        const r = await sign(ids.lm, img);
        assert.equal(r.status, 200, `${name} 签不了：${r.message}`);
        assert.deepEqual(await snap(ids), { status: "SIGNED", signImageBase64: img, ship: "delivered", logs: 1 }, name);
      }
    });

    await check("P4 已签收：换一张照片照旧能换、轨迹不加；不带照片 200 什么都不改；乱传 400 旧照片不丢", async () => {
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
  } finally {
    await cleanup();
    const left = (await pm.adminLastmileOrder.count({ where: { companyId: CO } })) + (await pm.shipment.count({ where: { companyId: CO } }))
      + (await pm.statusLog.count({ where: { companyId: CO } })) + (await pm.user.count({ where: { companyId: CO } }));
    if (left) { failed++; console.log(`❌ 测试数据没清干净：还剩 ${left} 行`); }
    await prisma.$disconnect();
  }
  console.log(`\n签收照片：通过 ${passed}，不通过 ${failed}`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
