/**
 * 2026-10-18 全系统审查老板选 B 修的 6 处 —— 连库那一半（真 handler + 真 PostgreSQL）：超管改单的版本核对（第二档第 6 条）。
 * 清单和核实依据：.audit/2026-10-18/full-review/核实结果.md；改坏验证记录在 .audit/2026-10-18/review-fix/。
 *
 *   V1  两份列表（超管「运单管理」/admin/orders、员工 /staff/shipments）给订单的 updatedAt（不是运单的），跟库里一样
 *   V2  超管「运单管理」改产品行带对的版本：存上；返回的 updatedAt = 库里订单的（产品行货型变了、后端第二次写订单也一样），
 *       拿返回值接着再存一次照样存上（不被自己当成「别人改过」）
 *   V3  拿旧版本改产品行（这期间另一个超管加了一行）：409、一个字都不写 —— 别人加的那行还在（旧：被删掉）
 *   V4  只改单个字段、不带版本（老口径）：照旧存上，不因为别人改过别的字段就拦
 *   V5  超管在员工页「保存订单信息」（patch-shipment-bundle）拿旧版本：409、什么都不写 —— 别人刚改的重量、备注不被整份旧草稿写回去（旧：被写回）
 *   V6  patch-shipment-bundle 带对的版本：存上；返回的 updatedAt = 库里订单的，拿它再存一次照样存上
 *   V7  patch-shipment-bundle 不带版本（上线那一刻还开着的老页面）：照旧存上
 *   V8  「运单管理」只改备注也带版本（第 2 轮起每次都带）：别人这期间改过产品行 → 409、备注不写（旧：不核对就存，基线换成新版本，下次改产品行漏拦）
 *   V9  客户批量下单带请求编号：同一个编号交两次只建一张，第二次回第一次的结果（服务器建好了、回话丢了再重试的情况）
 *   V10 同一个编号两个请求同时进来：都回同一张、库里只有一张
 *   V11 编号是别的客户用过的 409；格式不对 400；不带编号（单张下单 / 老页面）照旧每次新建
 *
 * 只连测试库：DATABASE_URL 不带 neon.tech 的不跑（一次性 docker 库设 AGENT_PORTAL_TEST_ALLOW_DB=1）；
 * 没有 DATABASE_URL 打印「跳过」。测试数据全在假公司 zz_rv18_co 下，开跑前、跑完后都清干净。
 */
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";

type Row = Record<string, any>;
type Auth = { userId: string; companyId: string; role: string; name: string; agentId: string | null };
const CO = "zz_rv18_co";
const ADMIN: Auth = { userId: "zz_rv18_admin", companyId: CO, role: "admin", name: "超管", agentId: null };
const ADMIN2: Auth = { userId: "zz_rv18_admin2", companyId: CO, role: "admin", name: "超管二", agentId: null };
const STAFF: Auth = { userId: "zz_rv18_staff", companyId: CO, role: "staff", name: "员工", agentId: null };
const C1: Auth = { userId: "ZZRV18C1", companyId: CO, role: "client", name: "客户一", agentId: null };
const C2: Auth = { userId: "ZZRV18C2", companyId: CO, role: "client", name: "客户二", agentId: null };
const NO = (s: string) => `ZZRV18${s}`;
const beijingDay = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (!url.includes("neon.tech") && process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：DATABASE_URL 不是 Neon 测试库，怕连到生产库不跑（确认是测试库可设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  process.env.IMAGES_DIR = process.env.IMAGES_DIR || path.join(os.tmpdir(), "zz_rv18_images");
  const { prisma } = await import("../apps/api/src/db/prisma");
  const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
  const pm: any = prisma;

  const routes = new Map<string, Function>();
  const app: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) app[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
  (await import("../apps/api/src/modules/orders/routes")).registerOrderRoutes(app);
  (await import("../apps/api/src/modules/shipments/routes")).registerShipmentRoutes(app);
  (await import("../apps/api/src/modules/admin/routes")).registerAdminRoutes(app);

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

  /** 员工建一张两款产品的单（产品行带 id，跟线上一样） */
  async function newOrder(trackingNo: string): Promise<{ orderId: string; shipmentId: string }> {
    const d = await must("POST /staff/orders", STAFF, {
      clientId: C1.userId, trackingNo, itemName: "鞋", packageCount: 5, transportMode: "sea", warehouseId: "wh_yiwu_01", arrivedAt: beijingDay(),
      products: [
        { itemName: "鞋", packageCount: 2, lengthCm: 40, widthCm: 30, heightCm: 20, weightKg: 5, cargoType: "normal", domesticTrackingNo: "SF001" },
        { itemName: "包", packageCount: 3, lengthCm: 40, widthCm: 30, heightCm: 20, weightKg: 4, cargoType: "normal", domesticTrackingNo: "SF002" },
      ],
    });
    const s = await pm.shipment.findFirst({ where: { trackingNo }, select: { id: true } });
    return { orderId: d.orderId, shipmentId: s.id };
  }
  const orderRow = (orderId: string) => pm.order.findFirst({ where: { id: orderId } });
  /** 备注存在父运单上（schema Shipment.remark），两条改单路都写它 */
  const remarkOf = async (orderId: string) => (await pm.shipment.findFirst({ where: { orderId, parentTrackingNo: null } }))?.remark ?? null;
  const productsOf = async (orderId: string) => pm.orderProduct.findMany({ where: { orderId }, orderBy: { sortOrder: "asc" } });
  /** 「运单管理」弹窗发的产品行：带 id 的改、不带 id 的新增 */
  const asPayload = (rows: Row[]) => rows.map((p) => ({
    id: p.id, itemName: p.itemName, packageCount: p.packageCount, lengthCm: p.lengthCm, widthCm: p.widthCm, heightCm: p.heightCm,
    productQuantity: p.productQuantity, weightKg: p.weightKg, cargoType: p.cargoType, domesticTrackingNo: p.domesticTrackingNo,
  }));
  /** 员工页「保存订单信息」那份整草稿（打开时那一刻的样子） */
  async function bundleDraft(shipmentId: string): Promise<Row> {
    const s = await pm.shipment.findFirst({ where: { id: shipmentId }, include: { order: true } });
    const o = s.order;
    return {
      shipmentId, trackingNo: s.trackingNo, itemName: o.itemName, packageCount: s.packageCount, basePackageCount: s.packageCount,
      productQuantity: o.productQuantity, packageUnit: "box", weightKg: Number(s.weightKg), volumeM3: Number(s.volumeM3),
      domesticTrackingNo: o.domesticTrackingNo, transportMode: o.transportMode, shipDate: o.shipDate, warehouseId: s.warehouseId,
      receiverAddressTh: o.receiverAddressTh ?? "", orderCreatedDate: o.shipDate ?? beijingDay(), remark: s.remark ?? null,
    };
  }

  async function cleanup(): Promise<void> {
    await pm.statusLog.deleteMany({ where: { companyId: CO } });
    await pm.orderProductImage.deleteMany({ where: { companyId: CO } });
    await pm.orderProduct.deleteMany({ where: { companyId: CO } });
    await pm.shipment.deleteMany({ where: { companyId: CO, parentTrackingNo: { not: null } } });
    await pm.shipment.deleteMany({ where: { companyId: CO } });
    await pm.order.deleteMany({ where: { companyId: CO } });
    await pm.auditLog.deleteMany({ where: { companyId: CO } });
    await pm.user.deleteMany({ where: { companyId: CO } });
  }

  let passed = 0, failed = 0;
  async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`✅ ${name}`); }
    catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
  }

  await cleanup();
  try {
    for (const u of [ADMIN, ADMIN2, STAFF, C1, C2]) {
      await pm.user.create({ data: { id: u.userId, companyId: CO, role: u.role, name: u.name, passwordHash: "x", phone: `0${u.userId}`, status: "active" } });
    }

    await check("V1 两份列表给订单的 updatedAt（不是运单的），跟库里订单一样", async () => {
      const { orderId, shipmentId } = await newOrder(NO("L1"));
      // 让运单和订单的 updatedAt 拉开，免得碰巧一样骗过检查
      await pm.shipment.update({ where: { id: shipmentId }, data: { updatedAt: new Date(Date.now() + 60_000) } });
      const o = await orderRow(orderId);
      const adminList = await must("GET /admin/orders", ADMIN, {}, { pageSize: "500", page: "1" });
      const a = adminList.items.find((x: Row) => x.id === shipmentId);
      assert.ok(a, "超管列表里找不到这张单");
      assert.equal(a.orderUpdatedAt, o.updatedAt.toISOString(), "超管列表的 orderUpdatedAt 要是订单的");
      assert.notEqual(a.orderUpdatedAt, a.updatedAt, "orderUpdatedAt 不能拿运单的 updatedAt 顶");
      const staffList = await must("GET /staff/shipments", ADMIN, {}, { pageSize: "500", page: "1" });
      const s = staffList.items.find((x: Row) => x.id === shipmentId);
      assert.ok(s, "员工列表里找不到这张单");
      assert.equal(s.orderUpdatedAt, o.updatedAt.toISOString(), "员工列表的 orderUpdatedAt 要是订单的");
    });

    await check("V2 运单管理改产品行带对的版本：存上；返回的 updatedAt = 库里订单的（货型变了第二次写订单也一样）；拿它接着再存照样存上", async () => {
      const { orderId } = await newOrder(NO("A1"));
      const v0 = (await orderRow(orderId)).updatedAt.toISOString();
      const rows = await productsOf(orderId);
      // 第二款改成敏感货：后端会第二次写订单（整票货型），这一下的 updatedAt 也得跟返回值对上
      const p1 = asPayload(rows); p1[1].cargoType = "sensitive"; p1[1].packageCount = 4;
      const r1 = await must("POST /admin/orders/update", ADMIN, { orderId, expectedOrderUpdatedAt: v0, products: p1, packageCount: 6, productQuantity: 0, weightKg: 26, volumeM3: 0.144 });
      const o1 = await orderRow(orderId);
      assert.equal(o1.cargoType, "sensitive", "整票货型要跟着变（走到了第二次写订单那句）");
      assert.equal(r1.updatedAt, o1.updatedAt.toISOString(), "返回的 updatedAt 要等于库里订单的（不然页面拿它再存会被当成别人改过）");
      const p2 = asPayload(await productsOf(orderId)); p2[0].packageCount = 3;
      await must("POST /admin/orders/update", ADMIN, { orderId, expectedOrderUpdatedAt: r1.updatedAt, products: p2, packageCount: 7, productQuantity: 0, weightKg: 31, volumeM3: 0.168 });
      assert.equal((await productsOf(orderId))[0].packageCount, 3, "第二次也要存上");
    });

    await check("V3 拿旧版本改产品行（这期间别的超管加了一行）：409、什么都不写 —— 别人加的那行还在、改的不被盖回", async () => {
      const { orderId } = await newOrder(NO("A2"));
      const opened = (await orderRow(orderId)).updatedAt.toISOString();
      const openedRows = asPayload(await productsOf(orderId));
      // 超管二：加一行「帽」
      const now2 = asPayload(await productsOf(orderId));
      await must("POST /admin/orders/update", ADMIN2, { orderId, products: [...now2, { itemName: "帽", packageCount: 1, cargoType: "normal", domesticTrackingNo: "SF003" }], packageCount: 6, productQuantity: 0 });
      assert.equal((await productsOf(orderId)).length, 3);
      // 超管一：拿打开时那两行改件数再存（旧弹窗）
      const stale = openedRows.map((p) => ({ ...p })); stale[0].packageCount = 9;
      const r = await call("POST /admin/orders/update", ADMIN, { orderId, expectedOrderUpdatedAt: opened, products: stale, packageCount: 12, productQuantity: 0 });
      assert.equal(r.status, 409, `旧版本应该 409，实际 ${r.status}：${r.message}`);
      assert.match(r.message, /刚刚被别人改过/);
      const after = await productsOf(orderId);
      assert.deepEqual(after.map((p: Row) => p.itemName), ["鞋", "包", "帽"], "别人加的那行被删了");
      assert.equal(after[0].packageCount, 2, "被拦下的那次不能写进任何东西");
      assert.equal((await orderRow(orderId)).packageCount, 6);
    });

    await check("V4 只改单个字段、不带版本（老口径，跟别人改别的字段不冲突）：照旧存上", async () => {
      const { orderId } = await newOrder(NO("A3"));
      const rows = asPayload(await productsOf(orderId)); rows[0].packageCount = 1;
      await must("POST /admin/orders/update", ADMIN2, { orderId, products: rows, packageCount: 4, productQuantity: 0 });
      await must("POST /admin/orders/update", ADMIN, { orderId, remark: "只改备注" });
      assert.equal(await remarkOf(orderId), "只改备注");
      assert.equal((await productsOf(orderId))[0].packageCount, 1, "别人改的产品行不受影响");
    });

    await check("V5 员工页「保存订单信息」拿旧版本（这期间别人改了重量、备注）：409、什么都不写，别人改的不被整份旧草稿写回", async () => {
      const { orderId, shipmentId } = await newOrder(NO("B1"));
      const draft = await bundleDraft(shipmentId);
      const opened = (await orderRow(orderId)).updatedAt.toISOString();
      await must("POST /admin/orders/update", ADMIN2, { orderId, weightKg: 99, remark: "超管二改的" });
      const r = await call("POST /staff/orders/patch-shipment-bundle", ADMIN, { ...draft, remark: "超管一只改备注", expectedOrderUpdatedAt: opened });
      assert.equal(r.status, 409, `旧版本应该 409，实际 ${r.status}：${r.message}`);
      assert.match(r.message, /刚刚被别人改过/);
      const o = await orderRow(orderId);
      assert.equal(Number(o.weightKg), 99, "别人改的重量被旧草稿写回去了");
      assert.equal(await remarkOf(orderId), "超管二改的", "被拦下的那次不能写进任何东西");
    });

    await check("V6 员工页「保存订单信息」带对的版本：存上；返回的 updatedAt = 库里订单的，拿它再存一次照样存上", async () => {
      const { orderId, shipmentId } = await newOrder(NO("B2"));
      const v0 = (await orderRow(orderId)).updatedAt.toISOString();
      const r1 = await must("POST /staff/orders/patch-shipment-bundle", ADMIN, { ...(await bundleDraft(shipmentId)), remark: "第一次", expectedOrderUpdatedAt: v0 });
      const o1 = await orderRow(orderId);
      assert.equal(await remarkOf(orderId), "第一次");
      assert.equal(r1.updatedAt, o1.updatedAt.toISOString(), "返回的 updatedAt 要等于库里订单的");
      await must("POST /staff/orders/patch-shipment-bundle", ADMIN, { ...(await bundleDraft(shipmentId)), remark: "第二次", expectedOrderUpdatedAt: r1.updatedAt });
      assert.equal(await remarkOf(orderId), "第二次");
    });

    await check("V7 员工页「保存订单信息」不带版本（上线那一刻还开着的老页面）：照旧存上", async () => {
      const { orderId, shipmentId } = await newOrder(NO("B3"));
      await must("POST /admin/orders/update", ADMIN2, { orderId, remark: "先改一下" });
      await must("POST /staff/orders/patch-shipment-bundle", ADMIN, { ...(await bundleDraft(shipmentId)), remark: "老页面存的" });
      assert.equal(await remarkOf(orderId), "老页面存的");
    });

    await check("V8 「运单管理」只改备注也带打开时的版本：别人这期间改了产品行 → 409、备注不写", async () => {
      const { orderId } = await newOrder(NO("A4"));
      const opened = (await orderRow(orderId)).updatedAt.toISOString();
      const rows = asPayload(await productsOf(orderId)); rows[0].packageCount = 7;
      await must("POST /admin/orders/update", ADMIN2, { orderId, products: rows, packageCount: 10, productQuantity: 0 });
      const r = await call("POST /admin/orders/update", ADMIN, { orderId, expectedOrderUpdatedAt: opened, remark: "只改备注" });
      assert.equal(r.status, 409, `只改备注拿旧版本也该 409，实际 ${r.status}：${r.message}`);
      assert.equal(await remarkOf(orderId), null, "被拦下的那次不能写备注");
      assert.equal((await productsOf(orderId))[0].packageCount, 7, "别人改的产品行不受影响");
    });

    const prealert = (extra: Row = {}) => ({ warehouseId: "wh_yiwu_01", itemName: "批量货", packageCount: 2, packageUnit: "box", transportMode: "sea", ...extra });
    const ordersOf = async (client: Auth) => pm.order.count({ where: { companyId: CO, clientId: client.userId } });

    await check("V9 客户批量下单带请求编号：同一个编号交两次只建一张，第二次回第一次的结果", async () => {
      const before = await ordersOf(C1);
      const rid = "zzrv18req0000000000000000000001";
      const a = await must("POST /client/prealerts", C1, prealert({ requestId: rid }));
      const b = await must("POST /client/prealerts", C1, prealert({ requestId: rid }));
      assert.equal(b.prealertId, a.prealertId, "第二次应该回第一次那张");
      assert.equal(b.trackingNo, a.trackingNo);
      assert.equal(b.alreadyCreated, true);
      assert.equal((await ordersOf(C1)) - before, 1, "同一个编号建了两张");
      assert.equal(await pm.shipment.count({ where: { orderId: a.prealertId } }), 1, "运单也只能有一张");
    });

    await check("V10 同一个编号两个请求同时进来：都回同一张、库里只有一张", async () => {
      const before = await ordersOf(C1);
      const rid = "zzrv18req0000000000000000000002";
      const [a, b] = await Promise.all([call("POST /client/prealerts", C1, prealert({ requestId: rid })), call("POST /client/prealerts", C1, prealert({ requestId: rid }))]);
      assert.equal(a.status, 200, `${a.status} ${a.message}`);
      assert.equal(b.status, 200, `${b.status} ${b.message}`);
      assert.equal(a.data.prealertId, b.data.prealertId);
      assert.equal((await ordersOf(C1)) - before, 1, "同时进来的同编号建了两张");
    });

    await check("V11 编号是别的客户用过的 409；格式不对 400；不带编号照旧每次新建", async () => {
      const rid = "zzrv18req0000000000000000000001"; // V9 里客户一用过
      const r = await call("POST /client/prealerts", C2, prealert({ requestId: rid }));
      assert.equal(r.status, 409, `${r.status} ${r.message}`);
      assert.equal(await ordersOf(C2), 0, "别人的编号不能让我建出单、也不能回别人的单");
      for (const bad of ["短", "has space in it 1234", "x".repeat(65), 12345678901234567]) {
        const bd = await call("POST /client/prealerts", C1, prealert({ requestId: bad }));
        assert.equal(bd.status, 400, `编号 ${String(bad).slice(0, 20)} 应该 400，实际 ${bd.status}`);
      }
      const before = await ordersOf(C1);
      await must("POST /client/prealerts", C1, prealert());
      await must("POST /client/prealerts", C1, prealert());
      assert.equal((await ordersOf(C1)) - before, 2, "不带编号要照旧每次新建");
    });
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
  console.log(`\n${passed} 项通过，${failed} 项失败`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
