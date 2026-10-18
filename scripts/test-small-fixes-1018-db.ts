/**
 * 2026-10-18 晚 老板「小问题也修一下吧」—— 连库那一半（真 handler + 真 PostgreSQL）。
 * 清单：.audit/2026-10-18/small-fixes/plan.md；审查原文摘录在同目录 sources.md。
 *
 *   T1  确认收货改了品名：只有一行产品时产品行跟着改（#15）；多行产品不动；原样带回来的品名不碰产品行
 *   T2  员工页「订单详情」保存：到仓日期写进 ship_date，订单的创建时间一个字不动（#16，原来写进 created_at）
 *   T3  运单产品图：HEIC / TIFF / SVG 400、库里不多图（#21，原来存成 .jpg 破图）；大写的 IMAGE/PNG 照收、存成小写
 *   T4  改密码：客户不卡强度（6 位全数字照改）、跟旧的一样 / 太长 400；员工、代理照旧卡（#24）
 *   T5  普通集货余额付款写付款时间；撤销付款清掉；再付记新的（#25）
 *   T6  父单看轨迹：「装柜时间」那块把子单装过的柜合起来、同一个柜只算一次；清关放行日期那一列空着就从状态时间表取，
 *       有值就用那一列；客户和代理拿不到柜号（#17）
 *   T7  派送单追加：已经全部签收的车次 409、什么都不写；还有派送中的照旧能加（#23）
 *
 * 只连测试库：DATABASE_URL 不带 neon.tech 的不跑（一次性 docker 库设 AGENT_PORTAL_TEST_ALLOW_DB=1）；
 * 没有 DATABASE_URL 打印「跳过」。测试数据全在假公司 zz_sf18_co 下，开跑前、跑完后都清干净。
 */
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";

type Row = Record<string, any>;
type Auth = { userId: string; companyId: string; role: string; name: string; agentId: string | null };
const CO = "zz_sf18_co";
const AGENT_ID = "zz_sf18_agent";
const ADMIN: Auth = { userId: "zz_sf18_admin", companyId: CO, role: "admin", name: "超管", agentId: null };
const STAFF: Auth = { userId: "zz_sf18_staff", companyId: CO, role: "staff", name: "员工", agentId: null };
const C1: Auth = { userId: "ZZSF18C1", companyId: CO, role: "client", name: "客户一", agentId: null };
const C2: Auth = { userId: "ZZSF18C2", companyId: CO, role: "client", name: "客户二", agentId: null };
const AG: Auth = { userId: "zz_sf18_ag", companyId: CO, role: "agent", name: "代理", agentId: AGENT_ID };
const AGC: Auth = { userId: "ZZSF18AC", companyId: CO, role: "client", name: "代理的客户", agentId: null };
const NO = (s: string) => `ZZSF18${s}`;
const beijingDay = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
/** 1×1 透明 PNG */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (!url.includes("neon.tech") && process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：DATABASE_URL 不是 Neon 测试库，怕连到生产库不跑（确认是测试库可设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  process.env.IMAGES_DIR = process.env.IMAGES_DIR || path.join(os.tmpdir(), "zz_sf18_images");
  const { prisma } = await import("../apps/api/src/db/prisma");
  const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
  const { hashPassword, verifyPassword } = await import("../apps/api/src/modules/auth/crypto-utils");
  const { customsClearedAtOf } = await import("../apps/api/src/modules/containers/track-containers");
  const pm: any = prisma;

  const routes = new Map<string, Function>();
  const app: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) app[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
  (await import("../apps/api/src/modules/orders/routes")).registerOrderRoutes(app);
  (await import("../apps/api/src/modules/auth/routes")).registerAuthRoutes(app);
  (await import("../apps/api/src/modules/consolidation/routes")).registerConsolidationRoutes(app);
  (await import("../apps/api/src/modules/containers/routes")).registerContainerRoutes(app);
  (await import("../apps/api/src/modules/agent-portal/routes")).registerAgentPortalRoutes(app);
  (await import("../apps/api/src/modules/admin-ops/routes")).registerAdminOpsRoutes(app);

  /** 跟 server.ts 一样：BusinessError 按它的状态码回；别的异常 = 线上的 500 */
  async function call(key: string, auth: Auth, body: Row = {}, query: Record<string, string> = {}): Promise<{ status: number; data: any; message: string }> {
    const handler = routes.get(key);
    if (!handler) return { status: 404, data: undefined, message: `没有这个接口：${key}` };
    let status = 200; let raw: any;
    const res: any = { status(s: number) { status = s; return res; }, json(p: any) { raw = p; }, setHeader() {} };
    try { await handler({ method: key.split(" ")[0], body, query, headers: {}, auth, path: key.split(" ")[1] }, res); }
    catch (e: any) {
      if (e instanceof BusinessError) { status = e.httpStatus; raw = { code: e.code, message: e.message }; }
      else { status = 500; raw = { code: "INTERNAL_ERROR", message: String(e?.message ?? e) }; }
    }
    return { status, data: raw?.data, message: raw?.message ?? "" };
  }
  async function must(key: string, auth: Auth, body: Row = {}, query: Record<string, string> = {}): Promise<any> {
    const r = await call(key, auth, body, query);
    assert.equal(r.status, 200, `${key} 应该成功，实际 ${r.status}：${r.message}`);
    return r.data;
  }

  const recv = { receiverNameTh: "r", receiverPhoneTh: "0", receiverAddressTh: "曼谷" };
  const mkOrder = (id: string, clientId: string, extra: Row = {}) => pm.order.create({ data: {
    id, companyId: CO, clientId, warehouseId: "wh_yiwu_01", itemName: "鞋", productQuantity: 0,
    packageCount: 10, packageUnit: "box", transportMode: "sea", weightKg: 10, volumeM3: 1, approvalStatus: "approved", ...recv, ...extra,
  } });
  const mkShip = (id: string, orderId: string, trackingNo: string, currentStatus: string, extra: Row = {}) => pm.shipment.create({ data: {
    id, companyId: CO, orderId, trackingNo, currentStatus, warehouseId: "wh_yiwu_01", transportMode: "sea", packageCount: 10, weightKg: 10, volumeM3: 1, ...extra,
  } });
  const mkProduct = (orderId: string, itemName: string, sortOrder: number) => pm.orderProduct.create({ data: {
    companyId: CO, orderId, itemName, packageCount: 5, sortOrder, domesticTrackingNo: `SF${sortOrder}`,
  } });
  const productNames = async (orderId: string) => (await pm.orderProduct.findMany({ where: { orderId }, orderBy: { sortOrder: "asc" } })).map((p: Row) => p.itemName);

  async function cleanup(): Promise<void> {
    const cs = await pm.container.findMany({ where: { companyId: CO }, select: { id: true } });
    await pm.adminLastmileOrder.deleteMany({ where: { companyId: CO } });
    await pm.shipmentContainerItem.deleteMany({ where: { containerId: { in: cs.map((c: Row) => c.id) } } });
    await pm.container.deleteMany({ where: { companyId: CO } });
    await pm.statusLog.deleteMany({ where: { companyId: CO } });
    await pm.orderProductImage.deleteMany({ where: { companyId: CO } });
    await pm.orderProduct.deleteMany({ where: { companyId: CO } });
    await pm.shipment.deleteMany({ where: { companyId: CO, parentTrackingNo: { not: null } } });
    await pm.shipment.deleteMany({ where: { companyId: CO } });
    await pm.order.deleteMany({ where: { companyId: CO } });
    await pm.consolidationBalanceLedger.deleteMany({ where: { companyId: CO } });
    await pm.clientWalletAccount.deleteMany({ where: { companyId: CO } });
    await pm.consolidationStatusLog.deleteMany({ where: { companyId: CO } });
    await pm.consolidationTask.deleteMany({ where: { companyId: CO } });
    await pm.auditLog.deleteMany({ where: { companyId: CO } });
    await pm.user.deleteMany({ where: { companyId: CO } });
    await pm.agent.deleteMany({ where: { id: AGENT_ID } });
  }

  let passed = 0, failed = 0;
  async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`✅ ${name}`); }
    catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
  }

  await cleanup();
  try {
    await pm.agent.create({ data: { id: AGENT_ID, companyId: CO, name: "代理", priceNormal: 1, priceInspection: 1, priceSensitive: 1 } });
    for (const u of [ADMIN, STAFF, C1, C2, AG, AGC]) {
      await pm.user.create({ data: {
        id: u.userId, companyId: CO, role: u.role, name: u.name, phone: `0${u.userId}`, status: "active",
        // 客户的密码就是唛头本身（线上就是这样）；员工 / 代理给个够强的
        passwordHash: hashPassword(u.role === "client" ? u.userId : "Zz-sf18-Old-Pass!"),
        agentId: u === AG || u === AGC ? AGENT_ID : null,
      } });
    }

    // ---------- T1 确认收货改品名 ----------
    await mkOrder("zz_sf18_r1", C1.userId, { approvalStatus: "shipped" });
    await mkShip("zz_sf18_r1p", "zz_sf18_r1", NO("R1"), "created");
    await mkProduct("zz_sf18_r1", "鞋子", 0);
    await mkOrder("zz_sf18_r2", C1.userId, { approvalStatus: "shipped" });
    await mkShip("zz_sf18_r2p", "zz_sf18_r2", NO("R2"), "created");
    await mkProduct("zz_sf18_r2", "鞋子", 0);
    await mkProduct("zz_sf18_r2", "包", 1);
    await mkOrder("zz_sf18_r3", C1.userId, { approvalStatus: "shipped" });
    await mkShip("zz_sf18_r3p", "zz_sf18_r3", NO("R3"), "created");
    await mkProduct("zz_sf18_r3", "鞋子", 0);
    await check("T1a 只有一行产品、确认收货改了品名：产品行跟着改（原来产品行还是客户报的名字，列表 / 导出照旧显示旧名）", async () => {
      await must("POST /staff/prealerts/receive", STAFF, { orderId: "zz_sf18_r1", itemName: " 运动鞋 ", packageCount: 10, weightKg: 10, volumeM3: 1 });
      assert.equal((await pm.order.findUnique({ where: { id: "zz_sf18_r1" } })).itemName, "运动鞋", "订单品名没改");
      assert.deepEqual(await productNames("zz_sf18_r1"), ["运动鞋"], "唯一那行产品的品名没跟着改");
    });
    await check("T1b 两行产品：分不清改的是哪一行，产品行一个都不动", async () => {
      await must("POST /staff/prealerts/receive", STAFF, { orderId: "zz_sf18_r2", itemName: "运动鞋", packageCount: 10, weightKg: 10, volumeM3: 1 });
      assert.deepEqual(await productNames("zz_sf18_r2"), ["鞋子", "包"], "多行产品被改了");
    });
    await check("T1c 页面原样带回订单的品名（没改）：不碰产品行（产品行跟订单名字本来就不一样也不覆盖）", async () => {
      await must("POST /staff/prealerts/receive", STAFF, { orderId: "zz_sf18_r3", itemName: "鞋", packageCount: 10, weightKg: 10, volumeM3: 1 });
      assert.deepEqual(await productNames("zz_sf18_r3"), ["鞋子"], "没改品名却把产品行覆盖成了订单的名字");
    });

    // ---------- T2 员工页「订单详情」到仓日期 ----------
    await check("T2 「保存订单信息」改到仓日期：写进 ship_date（列表 / 导出 / 筛选读的那个），订单创建时间不动（原来写进 created_at）", async () => {
      const d = await must("POST /staff/orders", STAFF, {
        clientId: C1.userId, trackingNo: NO("B1"), itemName: "鞋", packageCount: 5, transportMode: "sea", warehouseId: "wh_yiwu_01", arrivedAt: beijingDay(),
        products: [{ itemName: "鞋", packageCount: 5, lengthCm: 40, widthCm: 30, heightCm: 20, weightKg: 5, cargoType: "normal", domesticTrackingNo: "SF001" }],
      });
      const before = await pm.order.findUnique({ where: { id: d.orderId } });
      const s = await pm.shipment.findFirst({ where: { trackingNo: NO("B1") } });
      const r = await call("POST /staff/orders/patch-shipment-bundle", ADMIN, {
        shipmentId: s.id, trackingNo: s.trackingNo, itemName: "鞋", packageCount: 5, basePackageCount: 5, productQuantity: 0, packageUnit: "box",
        weightKg: Number(s.weightKg), volumeM3: Number(s.volumeM3), domesticTrackingNo: before.domesticTrackingNo, transportMode: "sea",
        orderCreatedDate: "2026-09-01", shipDate: "2026-09-01", warehouseId: "wh_yiwu_01", receiverAddressTh: "", remark: null,
        baseOrderUpdatedAt: before.updatedAt.toISOString(),
      });
      assert.equal(r.status, 200, r.message);
      const after = await pm.order.findUnique({ where: { id: d.orderId } });
      assert.equal(after.shipDate, "2026-09-01", `到仓日期没存进 ship_date：${after.shipDate}`);
      assert.equal(after.createdAt.getTime(), before.createdAt.getTime(), `订单创建时间被改了：${before.createdAt.toISOString()} → ${after.createdAt.toISOString()}`);
    });

    // ---------- T3 产品图格式 ----------
    await mkOrder("zz_sf18_i1", C1.userId);
    await mkShip("zz_sf18_i1p", "zz_sf18_i1", NO("I1"), "inWarehouseCN");
    await check("T3a HEIC / TIFF / SVG 产品图：400、库里不多图（原来存成 .jpg、刷新就是破图）", async () => {
      for (const mime of ["image/heic", "image/HEIF", "image/tiff", "image/svg+xml"]) {
        const r = await call("POST /staff/orders/product-images", ADMIN, { orderId: "zz_sf18_i1", fileName: "a.img", mime, contentBase64: PNG_1X1 });
        assert.equal(r.status, 400, `${mime} 没被拦（${r.status}：${r.message}）`);
        assert.ok(/显示不了/.test(r.message), `${mime} 的提示没说清：${r.message}`);
        if (/hei/i.test(mime)) assert.ok(r.message.includes("HEIC"), `苹果原图没说是 HEIC：${r.message}`);
      }
      assert.equal(await pm.orderProductImage.count({ where: { orderId: "zz_sf18_i1" } }), 0, "被拦的图进库了");
    });
    await check("T3b 大写的 IMAGE/PNG（类型不分大小写）照收，存成小写", async () => {
      const r = await call("POST /staff/orders/product-images", ADMIN, { orderId: "zz_sf18_i1", fileName: "a.png", mime: "IMAGE/PNG", contentBase64: PNG_1X1 });
      assert.equal(r.status, 200, r.message);
      const rows = await pm.orderProductImage.findMany({ where: { orderId: "zz_sf18_i1" } });
      assert.deepEqual(rows.map((x: Row) => x.mime), ["image/png"]);
    });

    // ---------- T4 改密码 ----------
    const pwdOf = async (id: string) => (await pm.user.findUnique({ where: { id } })).passwordHash as string;
    await check("T4a 客户改成 6 位全数字：照改，新密码能用（原来被员工的强密码规则拦）", async () => {
      const r = await call("POST /auth/change-password", C1, { oldPassword: C1.userId, newPassword: "123456" });
      assert.equal(r.status, 200, r.message);
      assert.ok(verifyPassword("123456", await pwdOf(C1.userId)), "库里的密码没换成新的");
    });
    await check("T4b 客户改成跟唛头一样（就是客户的老规矩）：照改", async () => {
      const r = await call("POST /auth/change-password", C2, { oldPassword: C2.userId, newPassword: C2.userId.toLowerCase() });
      assert.equal(r.status, 200, r.message);
    });
    await check("T4c 客户：跟旧的一样 / 超过 128 位 → 400，密码不动", async () => {
      const h = await pwdOf(C1.userId);
      const same = await call("POST /auth/change-password", C1, { oldPassword: "123456", newPassword: "123456" });
      assert.equal(same.status, 400, same.message);
      const long = await call("POST /auth/change-password", C1, { oldPassword: "123456", newPassword: "a".repeat(129) });
      assert.equal(long.status, 400, long.message);
      assert.equal(await pwdOf(C1.userId), h, "被拦了密码却变了");
    });
    await check("T4d 员工、代理改成弱密码照旧被拦（只放客户）", async () => {
      for (const who of [STAFF, AG]) {
        const h = await pwdOf(who.userId);
        const r = await call("POST /auth/change-password", who, { oldPassword: "Zz-sf18-Old-Pass!", newPassword: "12345678" });
        assert.equal(r.status, 400, `${who.role} 改弱密码没被拦：${r.status} ${r.message}`);
        assert.equal(await pwdOf(who.userId), h);
      }
    });

    // ---------- T5 普通集货余额付款的付款时间 ----------
    await check("T5 余额付款记付款时间；撤销付款清掉；再付记新的（原来余额付款不写，客户详情不显示、撤销再付显示的还是第一次）", async () => {
      await pm.clientWalletAccount.create({ data: { clientId: C1.userId, companyId: CO, currency: "CNY", balance: 1000 } });
      const t = await pm.consolidationTask.create({ data: {
        taskNo: NO("T1"), companyId: CO, clientId: C1.userId, destinationTh: "曼谷", status: "quoted", paymentStatus: "unpaid", totalFee: 300,
      } });
      const t0 = Date.now();
      await must("POST /client/consolidation/pay", C1, { taskId: t.id });
      const p1 = await pm.consolidationTask.findUnique({ where: { id: t.id } });
      assert.equal(p1.paymentStatus, "paid");
      assert.ok(p1.paidAt, "余额付款没写付款时间");
      assert.ok(p1.paidAt.getTime() >= t0 - 1000 && p1.paidAt.getTime() <= Date.now() + 1000, `付款时间不对：${p1.paidAt.toISOString()}`);
      await must("POST /admin/consolidation/payments/revoke", ADMIN, { taskId: t.id, reason: "测试" });
      const p2 = await pm.consolidationTask.findUnique({ where: { id: t.id } });
      assert.equal(p2.paymentStatus, "unpaid");
      assert.equal(p2.paidAt, null, "撤销付款后付款时间还留着");
      await new Promise((r) => setTimeout(r, 20));
      await must("POST /client/consolidation/pay", C1, { taskId: t.id });
      const p3 = await pm.consolidationTask.findUnique({ where: { id: t.id } });
      assert.ok(p3.paidAt && p3.paidAt.getTime() > p1.paidAt.getTime(), "再付的时候没记新的付款时间");
    });

    // ---------- T6 父单看轨迹 ----------
    const CLEARED = "2026-09-20T02:00:00.000Z";
    const K1 = await pm.container.create({ data: {
      companyId: CO, containerNo: "ZZSF18K1", containerType: "40HQ", currentStatus: "CUSTOMS_CLEARED", transportMode: "sea",
      loadingDate: new Date("2026-09-10T02:00:00Z"), statusDates: JSON.stringify({ LOADING: "2026-09-10T02:00:00.000Z", CUSTOMS_CLEARED: CLEARED }),
      createdAt: new Date("2026-09-10T01:00:00Z"),
    } });
    const K2 = await pm.container.create({ data: {
      companyId: CO, containerNo: "ZZSF18K2", containerType: "40HQ", currentStatus: "CUSTOMS_CLEARED", transportMode: "sea",
      loadingDate: new Date("2026-09-12T02:00:00Z"), customsClearedAt: new Date("2026-09-25T02:00:00Z"),
      statusDates: JSON.stringify({ CUSTOMS_CLEARED: "2026-09-24T02:00:00.000Z" }), createdAt: new Date("2026-09-12T01:00:00Z"),
    } });
    for (const [owner, base] of [[AGC.userId, "T"], [C1.userId, "U"]] as const) {
      await mkOrder(`zz_sf18_${base}`, owner);
      await mkShip(`zz_sf18_${base}p`, `zz_sf18_${base}`, NO(base), "loaded", { packageCount: 0, volumeM3: 0 });
    }
    // T 这票：两张子单装在 K1、一张装在 K2；父单自己身上没有柜（现在装柜一律先拆子单）。
    // 第一张子单装的是后建的 K2 —— 按柜子建的先后排才是 K1 在前（不排的话就是 K2 在前）
    let n = 0;
    for (const [container, vol, pcs] of [[K2, 2, 5], [K1, 1, 3], [K1, 0.5, 2]] as const) {
      n++;
      await mkShip(`zz_sf18_Tc${n}`, "zz_sf18_T", `${NO("T")}-${n}`, "loaded", { parentTrackingNo: NO("T"), packageCount: pcs, volumeM3: vol });
      await pm.shipmentContainerItem.create({ data: { shipmentId: `zz_sf18_Tc${n}`, containerId: container.id, loadedVolumeM3: vol, loadedPieceCount: pcs } });
    }
    // U 这票：父单自己装在 K2（老数据样子）、子单装在 K2 —— 同一个柜只算一次
    await mkShip("zz_sf18_Uc1", "zz_sf18_U", `${NO("U")}-1`, "loaded", { parentTrackingNo: NO("U"), packageCount: 4, volumeM3: 0.4 });
    await pm.shipmentContainerItem.create({ data: { shipmentId: "zz_sf18_Up", containerId: K2.id, loadedVolumeM3: 0.6, loadedPieceCount: 6 } });
    await pm.shipmentContainerItem.create({ data: { shipmentId: "zz_sf18_Uc1", containerId: K2.id, loadedVolumeM3: 0.4, loadedPieceCount: 4 } });

    const dates = (cs: Row[]) => cs.map((c) => [c.loadingDate, c.customsClearedAt]);
    const EXPECT = [["2026-09-10T02:00:00.000Z", CLEARED], ["2026-09-12T02:00:00.000Z", "2026-09-25T02:00:00.000Z"]];
    await check("T6a 客户点父单看轨迹：两张子单装的同一个柜只出一次、另一个柜也在，按装柜先后；清关放行那一列空着就取状态时间表；没有柜号", async () => {
      const r = await call("GET /client/shipments/track", AGC, {}, { trackingNo: NO("T") });
      assert.equal(r.status, 200, r.message);
      assert.deepEqual(dates(r.data.containers), EXPECT, `「装柜时间」不对：${JSON.stringify(r.data.containers)}`);
      assert.ok(!JSON.stringify(r.data).includes("ZZSF18K"), "客户拿到了柜号");
      assert.ok(r.data.containers.every((c: Row) => !("containerNo" in c) && !("containerId" in c)), "客户的柜子信息里带了柜号 / 柜子 id");
    });
    await check("T6b 员工看同一票：拆了 2 个柜、已装方数 / 件数按柜加起来，柜号照给", async () => {
      const r = await call("GET /client/shipments/track", STAFF, {}, { trackingNo: NO("T") });
      assert.equal(r.status, 200, r.message);
      assert.equal(r.data.splitCount, 2);
      assert.equal(r.data.isSplit, true);
      assert.equal(r.data.totalLoadedM3, 3.5);
      assert.deepEqual(r.data.containers.map((c: Row) => [c.containerNo, c.loadedVolumeM3, c.loadedPieceCount, c.customsClearedAt]),
        [["ZZSF18K1", 1.5, 5, CLEARED], ["ZZSF18K2", 2, 5, "2026-09-25T02:00:00.000Z"]]);
    });
    await check("T6c 代理看同一票：跟客户一样的两个柜、同样的日期，没有柜号", async () => {
      const r = await call("GET /agent/shipments/track", AG, {}, { trackingNo: NO("T") });
      assert.equal(r.status, 200, r.message);
      assert.deepEqual(dates(r.data.containers), EXPECT, `代理的「装柜时间」不对：${JSON.stringify(r.data.containers)}`);
      assert.ok(!JSON.stringify(r.data).includes("ZZSF18K"), "代理拿到了柜号");
    });
    await check("T6d 父单自己和子单装在同一个柜（老数据样子）：只出一个柜，方数 / 件数加起来", async () => {
      const r = await call("GET /client/shipments/track", STAFF, {}, { trackingNo: NO("U") });
      assert.equal(r.status, 200, r.message);
      assert.equal(r.data.splitCount, 1);
      assert.equal(r.data.isSplit, false);
      assert.deepEqual(r.data.containers.map((c: Row) => [c.containerNo, c.loadedVolumeM3, c.loadedPieceCount]), [["ZZSF18K2", 1, 10]]);
      const c = await call("GET /client/shipments/track", C1, {}, { trackingNo: NO("U") });
      assert.equal(c.status, 200, c.message);
      assert.equal(c.data.containers.length, 1);
    });
    await check("T6e 清关放行日期取法：那一列有值用那一列；状态时间表坏了 / 没这一格 / 日期乱写都是空，不报错", async () => {
      assert.equal(customsClearedAtOf({ customsClearedAt: new Date(CLEARED), statusDates: "{坏的" }), CLEARED);
      assert.equal(customsClearedAtOf({ customsClearedAt: null, statusDates: "{坏的" }), null);
      assert.equal(customsClearedAtOf({ customsClearedAt: null, statusDates: JSON.stringify({ LOADING: CLEARED }) }), null);
      assert.equal(customsClearedAtOf({ customsClearedAt: null, statusDates: JSON.stringify({ CUSTOMS_CLEARED: "不是日期" }) }), null);
      assert.equal(customsClearedAtOf({ customsClearedAt: null, statusDates: "null" }), null);
      assert.equal(customsClearedAtOf({ customsClearedAt: null, statusDates: null }), null);
    });

    // ---------- T7 派送单追加 ----------
    for (const id of ["W1", "W2", "W3", "W4"]) {
      await mkOrder(`zz_sf18_${id}`, C1.userId);
      await mkShip(`zz_sf18_${id}p`, `zz_sf18_${id}`, NO(id), id === "W1" || id === "W3" ? "delivered" : "inWarehouseTH");
    }
    const lm = (id: string, deliveryNo: string, shipmentId: string, status: string) => pm.adminLastmileOrder.create({ data: {
      id, companyId: CO, deliveryNo, shipmentId, carrierName: "自营", externalTrackingNo: "", driverName: "张三", status,
    } });
    await lm("zz_sf18_lm1", "ZZSF18WD1", "zz_sf18_W1p", "SIGNED");
    await lm("zz_sf18_lm3", "ZZSF18WD3", "zz_sf18_W3p", "SIGNED");
    await lm("zz_sf18_lm4", "ZZSF18WD3", "zz_sf18_W4p", "DELIVERING");
    await pm.shipment.update({ where: { id: "zz_sf18_W4p" }, data: { currentStatus: "outForDelivery" } });
    await check("T7a 往已经全部签收的车次（页面显示「派送完成」）追加：409、运单不改状态、不多派送行、不写轨迹", async () => {
      const r = await call("POST /admin/lastmile/orders", ADMIN, { shipmentIds: ["zz_sf18_W2p"], deliveryNo: "ZZSF18WD1" });
      assert.equal(r.status, 409, `没拦住：${r.status} ${r.message}`);
      assert.ok(r.message.includes("已经全部签收"), r.message);
      assert.equal((await pm.shipment.findUnique({ where: { id: "zz_sf18_W2p" } })).currentStatus, "inWarehouseTH");
      assert.equal(await pm.adminLastmileOrder.count({ where: { deliveryNo: "ZZSF18WD1" } }), 1);
      assert.equal(await pm.statusLog.count({ where: { shipmentId: "zz_sf18_W2p" } }), 0);
    });
    await check("T7b 车里还有派送中的（签了一部分）：照旧能加，司机信息照旧继承", async () => {
      const r = await call("POST /admin/lastmile/orders", ADMIN, { shipmentIds: ["zz_sf18_W2p"], deliveryNo: "ZZSF18WD3" });
      assert.equal(r.status, 200, r.message);
      const row = await pm.adminLastmileOrder.findFirst({ where: { deliveryNo: "ZZSF18WD3", shipmentId: "zz_sf18_W2p" } });
      assert.ok(row, "没加进去");
      assert.equal(row.status, "DELIVERING");
      assert.equal(row.driverName, "张三");
      assert.equal((await pm.shipment.findUnique({ where: { id: "zz_sf18_W2p" } })).currentStatus, "outForDelivery");
    });
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
