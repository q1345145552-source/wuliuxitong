/**
 * 2026-09-29 晚 Codex 全系统检查修的后端问题（老板选 A）—— 真库 + 真路由。
 *
 *   S1 撤销签收：同一票货两张已签收派送单，撤其中一张要挡（原来运单被改回派送中）
 *   S2 建单重量 / 体积 / 产品行长宽高不许负数（客户建预报单、员工建单两条路）
 *   S3 客户「预报单」列表取父运单（原来分柜后取最新的子单）
 *   S4 整柜排了派送单以后不许换客户（原来派送卡片跟着换成别人的地址）
 *   S5 客户不分产品行下预报单：产品明细里的国内快递单号、长宽高用客户填的（原来写死「货拉拉」、尺寸空）
 *   S6 普通集货编辑预报单：页面上的旧行已经不在了就整次不存（原来悄悄丢行）—— 客户编辑、超管强制编辑两条路
 *   S7 两个人同时删同一件货物（普通版、仓库版）、同一张订单：后一个不许 500
 *   S8 整柜装柜日期按北京时间的今天卡；看板「本月」按北京时间 1 号零点算
 *   S9 同一客户同时新增两个默认地址：只能有一个默认
 *   S10 客户专属价格：写一半出错不许丢旧价格；同时保存不许存出两套
 *   S11 没填体积的货装柜 / 卸柜：体积保持没填，不写成 0
 *   S12 仓库版计划详情带上每张预报单一共几条日志（页面要说「只显示最近 50 条，共 N 条」）
 *
 * 只连一次性库：DATABASE_URL 不是 Neon 时要 AGENT_PORTAL_TEST_ALLOW_DB=1。测试数据前缀 zz_sc29_，跑完清到 0。
 */
process.env.TZ = process.env.TZ || "UTC";
import assert from "node:assert/strict";

type Auth = { userId: string; companyId: string; role: "admin" | "staff" | "client"; name: string };
type Row = Record<string, any>;

const CO = "zz_sc29_co";
const ADMIN: Auth = { userId: "zz_sc29_admin", companyId: CO, role: "admin", name: "检查超管" };
const STAFF: Auth = { userId: "zz_sc29_staff", companyId: CO, role: "staff", name: "检查员工" };
const C1: Auth = { userId: "ZZSC29C1", companyId: CO, role: "client", name: "检查客户一" };
const C2: Auth = { userId: "ZZSC29C2", companyId: CO, role: "client", name: "检查客户二" };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (!url.includes("neon.tech") && process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：DATABASE_URL 不是 Neon 测试库，怕连到生产库不跑（确认是测试库可设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  process.env.IMAGES_DIR = process.env.IMAGES_DIR || require("node:os").tmpdir() + "/zz_sc29_images";
  const { prisma } = await import("../apps/api/src/db/prisma");
  const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
  const pm: any = prisma;

  const routes = new Map<string, Function>();
  const app: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) app[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
  (await import("../apps/api/src/modules/orders/routes")).registerOrderRoutes(app);
  (await import("../apps/api/src/modules/admin-ops/routes")).registerAdminOpsRoutes(app);
  (await import("../apps/api/src/modules/admin/routes")).registerAdminRoutes(app);
  (await import("../apps/api/src/modules/consolidation/routes")).registerConsolidationRoutes(app);
  (await import("../apps/api/src/modules/loading-manifests/routes")).registerLoadingManifestRoutes(app);
  (await import("../apps/api/src/modules/containers/routes")).registerContainerRoutes(app);
  (await import("../apps/api/src/modules/fcl-containers/routes")).registerFclContainerRoutes(app);
  (await import("../apps/api/src/modules/whr-consolidation/routes")).registerWhrConsolidationRoutes(app);
  (await import("../apps/api/src/modules/whr-consolidation/staff-routes")).registerWhrConsolidationStaffRoutes(app);
  (await import("../apps/api/src/modules/whr-consolidation/client-routes")).registerWhrConsolidationClientRoutes(app);
  (await import("../apps/api/src/modules/client-addresses/routes")).registerClientAddressRoutes(app);
  (await import("../apps/api/src/modules/shipping-config/routes")).registerShippingConfigRoutes(app);

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

  async function cleanup(): Promise<void> {
    const cs = await pm.container.findMany({ where: { companyId: CO }, select: { id: true } });
    const cids = cs.map((c: Row) => c.id);
    await pm.adminLastmileOrder.deleteMany({ where: { companyId: CO } });
    await pm.shipmentContainerItem.deleteMany({ where: { containerId: { in: cids } } });
    if (pm.containerPushEntry) await pm.containerPushEntry.deleteMany({ where: { companyId: CO } });
    if (pm.containerPushBatch) await pm.containerPushBatch.deleteMany({ where: { companyId: CO } });
    await pm.container.deleteMany({ where: { companyId: CO } });
    await pm.statusLog.deleteMany({ where: { companyId: CO } });
    await pm.orderProductImage.deleteMany({ where: { companyId: CO } });
    await pm.orderProduct.deleteMany({ where: { companyId: CO } });
    await pm.shipment.deleteMany({ where: { companyId: CO } });
    await pm.order.deleteMany({ where: { companyId: CO } });
    await pm.consolidationStatusLog.deleteMany({ where: { companyId: CO } });
    const tasks = await pm.consolidationTask.findMany({ where: { companyId: CO }, select: { id: true } });
    const pas = await pm.consolidationPrealert.findMany({ where: { taskId: { in: tasks.map((t: Row) => t.id) } }, select: { id: true } });
    await pm.consolidationPrealertProduct.deleteMany({ where: { prealertId: { in: pas.map((p: Row) => p.id) } } });
    await pm.consolidationPrealert.deleteMany({ where: { id: { in: pas.map((p: Row) => p.id) } } });
    await pm.consolidationTask.deleteMany({ where: { companyId: CO } });
    const plans = await pm.whrConsolidationPlan.findMany({ where: { companyId: CO }, select: { id: true } });
    const planIds = plans.map((p: Row) => p.id);
    await pm.whrConsolidationStatusLog.deleteMany({ where: { companyId: CO } });
    await pm.whrConsolidationPrealertItem.deleteMany({ where: { prealert: { planCustomer: { planId: { in: planIds } } } } });
    await pm.whrConsolidationPrealert.deleteMany({ where: { planCustomer: { planId: { in: planIds } } } });
    await pm.whrConsolidationPlanCustomer.deleteMany({ where: { planId: { in: planIds } } });
    await pm.whrConsolidationPlan.deleteMany({ where: { id: { in: planIds } } });
    await pm.clientAddress.deleteMany({ where: { companyId: CO } });
    await pm.pricingRule.deleteMany({ where: { companyId: CO } });
    await pm.consolidationBalanceLedger.deleteMany({ where: { companyId: CO } });
    await pm.clientWalletAccount.deleteMany({ where: { companyId: CO } });
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
    for (const u of [ADMIN, STAFF, C1, C2]) {
      await pm.user.create({ data: { id: u.userId, companyId: CO, role: u.role, name: u.name, passwordHash: "x", phone: `0${u.userId}`, status: "active" } });
    }
    const recv = { receiverNameTh: "r", receiverPhoneTh: "0", receiverAddressTh: "曼谷" };
    const mkOrder = (id: string, clientId = C1.userId) => pm.order.create({ data: {
      id, companyId: CO, clientId, warehouseId: "wh_yiwu_01", itemName: "鞋", productQuantity: 0,
      packageCount: 10, packageUnit: "box", transportMode: "sea", weightKg: 100, volumeM3: 1, approvalStatus: "approved", ...recv,
    } });
    const mkShip = (id: string, orderId: string, trackingNo: string, currentStatus: string, extra: Row = {}) => pm.shipment.create({ data: {
      id, companyId: CO, orderId, trackingNo, currentStatus, warehouseId: "wh_yiwu_01", transportMode: "sea", packageCount: 10, weightKg: 100, volumeM3: 1, ...extra,
    } });

    // ---------- S1 ----------
    await check("S1 同一票货两张派送单都已签收：撤销其中一张挡住，两张单和运单状态一样不动", async () => {
      await mkOrder("zz_sc29_o1");
      await mkShip("zz_sc29_s1", "zz_sc29_o1", "ZZSC29S1", "delivered");
      await pm.adminLastmileOrder.create({ data: { id: "zz_sc29_lm1a", companyId: CO, deliveryNo: "ZZSC29D1A", shipmentId: "zz_sc29_s1", carrierName: "车队", externalTrackingNo: "X", status: "SIGNED", signImageBase64: PNG } });
      await pm.adminLastmileOrder.create({ data: { id: "zz_sc29_lm1b", companyId: CO, deliveryNo: "ZZSC29D1B", shipmentId: "zz_sc29_s1", carrierName: "车队", externalTrackingNo: "X", status: "SIGNED", signImageBase64: PNG } });
      const r = await call("POST /admin/lastmile/unsign", ADMIN, { id: "zz_sc29_lm1a" });
      assert.equal(r.status, 409, `两张都签收了，撤一张没挡成 409（${r.status}）：${r.message}`);
      assert.match(r.message, /ZZSC29D1B/, `提示里没说另一张是哪张：${r.message}`);
      assert.equal((await pm.shipment.findUnique({ where: { id: "zz_sc29_s1" } })).currentStatus, "delivered", "运单被改回派送中了");
      assert.equal((await pm.adminLastmileOrder.findUnique({ where: { id: "zz_sc29_lm1a" } })).status, "SIGNED");
      // 只有一张已签收时照常能撤（不误挡）
      await pm.adminLastmileOrder.delete({ where: { id: "zz_sc29_lm1b" } });
      const ok = await call("POST /admin/lastmile/unsign", ADMIN, { id: "zz_sc29_lm1a" });
      assert.equal(ok.status, 200, `只剩一张签收的也撤不了：${ok.message}`);
      assert.equal((await pm.shipment.findUnique({ where: { id: "zz_sc29_s1" } })).currentStatus, "outForDelivery");
    });

    // ---------- S2 ----------
    await check("S2 客户建预报单 / 员工建单：负重量、负体积、负长宽高都挡住（中文提示、一张单都不建）；正常的照常建", async () => {
      const before = await pm.order.count({ where: { companyId: CO } });
      const base = { warehouseId: "wh_yiwu_01", itemName: "鞋", packageCount: 2, transportMode: "sea" };
      const bad = [
        await call("POST /client/prealerts", C1, { ...base, weightKg: -12.34 }),
        await call("POST /client/prealerts", C1, { ...base, volumeM3: -0.5 }),
        await call("POST /client/prealerts", C1, { ...base, products: [{ itemName: "鞋", packageCount: 2, lengthCm: -10, widthCm: 10, heightCm: 10 }] }),
        await call("POST /staff/orders", STAFF, { clientId: C1.userId, trackingNo: "ZZSC29NEG1", warehouseId: "wh_yiwu_01", itemName: "鞋", packageCount: 2, transportMode: "sea", arrivedAt: "2026-09-20", weightKg: -6 }),
        await call("POST /staff/orders", STAFF, { clientId: C1.userId, trackingNo: "ZZSC29NEG2", warehouseId: "wh_yiwu_01", itemName: "鞋", packageCount: 2, transportMode: "sea", arrivedAt: "2026-09-20", volumeM3: -0.6 }),
      ];
      // 卡在上限边上：舍到存库精度就是 1 亿 / 1000 万，原来照样放行、写库溢出 500（Codex 复查）
      bad.push(await call("POST /client/prealerts", C1, { ...base, weightKg: 99999999.999 }));
      bad.push(await call("POST /client/prealerts", C1, { ...base, volumeM3: 9999999.9999 }));
      bad.forEach((r, i) => {
        assert.equal(r.status, 400, `第 ${i + 1} 个负数请求没挡住（${r.status}）：${r.message}`);
        assert.match(r.message, /不小于 0|太大了/, `第 ${i + 1} 个提示不对：${r.message}`);
      });
      // 产品行算出来的总体积超过能存的范围（把毫米当厘米填）、产品行是 null：给中文提示，不许写库 500（dsh 第二轮复查）
      for (const [path, auth, extra] of [["POST /client/prealerts", C1, {}], ["POST /staff/orders", STAFF, { clientId: C1.userId, trackingNo: "ZZSC29BIG1", arrivedAt: "2026-09-20" }]] as const) {
        const big = await call(path, auth as Auth, { ...base, ...extra, products: [{ itemName: "鞋", packageCount: 50, lengthCm: 6000, widthCm: 6000, heightCm: 6000 }] });
        assert.equal(big.status, 400, `${path} 体积溢出没挡住（${big.status}）：${big.message}`);
        assert.match(big.message, /总体积/, big.message);
        const nul = await call(path, auth as Auth, { ...base, ...extra, products: [null] });
        assert.equal(nul.status, 400, `${path} products:[null]（${nul.status}）：${nul.message}`);
        assert.match(nul.message, /格式不对/, nul.message);
      }
      assert.equal(await pm.order.count({ where: { companyId: CO } }), before, "负数的单被建出来了");
      const ok = await call("POST /client/prealerts", C1, { ...base, weightKg: 12.34, volumeM3: 0.5 });
      assert.equal(ok.status, 200, `正常的单建不了：${ok.message}`);
      const ok2 = await call("POST /staff/orders", STAFF, { clientId: C1.userId, trackingNo: "ZZSC29POS1", warehouseId: "wh_yiwu_01", itemName: "鞋", packageCount: 2, transportMode: "sea", arrivedAt: "2026-09-20", weightKg: 6, volumeM3: 0.123456 });
      assert.equal(ok2.status, 200, `员工正常建单（体积带 6 位小数，页面自动算的就是这样）建不了：${ok2.message}`);
      // 7×7×7 厘米的样品盒 = 0.000343 方：合计只查上限、不查「舍成 0」，照常建单（dsh 第三轮：第一版把它当「填错单位」拦了）
      for (const [path, auth, extra] of [["POST /client/prealerts", C1, {}], ["POST /staff/orders", STAFF, { clientId: C1.userId, trackingNo: "ZZSC29SMALL1", arrivedAt: "2026-09-20" }]] as const) {
        const small = await call(path, auth as Auth, { ...base, ...extra, itemName: "样品盒", packageCount: 1, products: [{ itemName: "样品盒", packageCount: 1, lengthCm: 7, widthCm: 7, heightCm: 7, weightKg: 0.2 }] });
        assert.equal(small.status, 200, `${path} 7×7×7 样品盒建不了（${small.status}）：${small.message}`);
      }
      // 超管改单那条路先读货型、后查产品行：products:[null] 原来在读货型时 500（dsh 第三轮）
      const adminNull = await call("POST /admin/orders/update", ADMIN, { orderId: "zz_sc29_no_such_order", products: [null] });
      assert.equal(adminNull.status, 400, `超管改单 products:[null]（${adminNull.status}）：${adminNull.message}`);
      assert.match(adminNull.message, /产品行1的数据格式不对/, adminNull.message);
      // products 整个不是数组：原来读货型那一步 500（dsh 第四轮）
      for (const [path, auth, extra, bad] of [
        ["POST /admin/orders/update", ADMIN, { orderId: "zz_sc29_no_such_order" }, "abc"],
        ["POST /admin/orders/update", ADMIN, { orderId: "zz_sc29_no_such_order" }, { a: 1 }],
        ["POST /admin/orders/update", ADMIN, { orderId: "zz_sc29_no_such_order" }, 12345],
        ["POST /client/prealerts", C1, { ...base }, { a: 1 }],
        ["POST /staff/orders", STAFF, { ...base, clientId: C1.userId, trackingNo: "ZZSC29NOTARR", arrivedAt: "2026-09-20" }, { a: 1 }],
      ] as const) {
        const r = await call(path, auth as Auth, { ...extra, products: bad });
        assert.equal(r.status, 400, `${path} products=${JSON.stringify(bad)}（${r.status}）：${r.message}`);
        assert.match(r.message, /数据格式不对/, r.message);
      }
    });

    // ---------- S3 ----------
    await check("S3 客户「预报单」列表：分过柜的单显示父运单的单号和状态，不是最新那张子单", async () => {
      await mkOrder("zz_sc29_o3");
      await mkShip("zz_sc29_s3", "zz_sc29_o3", "ZZSC29S3", "inWarehouseTH", { packageCount: 0 });
      await new Promise((r) => setTimeout(r, 20));
      await mkShip("zz_sc29_s3c", "zz_sc29_o3", "ZZSC29S3-1", "outForDelivery", { parentTrackingNo: "ZZSC29S3" });
      const r = await call("GET /client/prealerts", C1, {}, { status: "all", page: "1", pageSize: "200" });
      assert.equal(r.status, 200, r.message);
      const items: any[] = r.data?.items ?? r.data ?? [];
      const row = items.find((x: any) => x.id === "zz_sc29_o3" || x.orderId === "zz_sc29_o3");
      assert.ok(row, `列表里没找到这张单：${JSON.stringify(items.slice(0, 2))}`);
      assert.equal(row.trackingNo, "ZZSC29S3", `显示的是 ${row.trackingNo}（子单）`);
      assert.equal(row.currentStatus, "inWarehouseTH");
    });

    // ---------- S4 ----------
    await check("S4 整柜排了派送单以后换客户：挡住（派送卡片按客户查地址，换了就送到别人那）；没排派送单照常能换", async () => {
      const make = async (bl: string, cn: string) => {
        const r = await call("POST /staff/fcl-containers/create", STAFF, {
          clientId: C1.userId, trackingNo: bl, containerNo: cn, containerType: "40HQ", transportMode: "sea", warehouseId: "wh_yiwu_01",
          loadingDate: "2026-09-10", amountCny: "12000", remark: "",
          products: [{ itemName: "鞋", packageCount: 10, quantityPerBox: 20, lengthCm: 60, widthCm: 40, heightCm: 30, unitWeightKg: 2.5, domesticTrackingNo: "SF1", cargoType: "normal" }],
        });
        assert.equal(r.status, 200, `建整柜失败：${r.message}`);
        return r.data;
      };
      const body = (d: any, bl: string, cn: string, clientId: string) => ({
        containerId: d.containerId, clientId, trackingNo: bl, containerNo: cn, containerType: "40HQ", transportMode: "sea", warehouseId: "wh_yiwu_01",
        loadingDate: "2026-09-10", amountCny: "12000", remark: "",
        products: [{ itemName: "鞋", packageCount: 10, quantityPerBox: 20, lengthCm: 60, widthCm: 40, heightCm: 30, unitWeightKg: 2.5, domesticTrackingNo: "SF1", cargoType: "normal" }],
      });
      const a = await make("ZZSC29BL1", "ZZSC29CN1");
      await pm.adminLastmileOrder.create({ data: { id: "zz_sc29_lm4", companyId: CO, deliveryNo: "ZZSC29D4", shipmentId: a.shipmentId, carrierName: "车队", externalTrackingNo: "X", status: "DELIVERING" } });
      const r = await call("POST /staff/fcl-containers/update", STAFF, body(a, "ZZSC29BL1", "ZZSC29CN1", C2.userId));
      assert.notEqual(r.status, 200, "排了派送单还是把客户换了");
      assert.match(r.message, /ZZSC29D4/, r.message);
      const ship = await pm.shipment.findUnique({ where: { id: a.shipmentId }, include: { order: true } });
      assert.equal(ship.order.clientId, C1.userId, "订单的客户被换了");
      const b = await make("ZZSC29BL2", "ZZSC29CN2");
      const ok = await call("POST /staff/fcl-containers/update", STAFF, body(b, "ZZSC29BL2", "ZZSC29CN2", C2.userId));
      assert.equal(ok.status, 200, `没排派送单的也换不了客户：${ok.message}`);
    });

    // ---------- S5 ----------
    await check("S5 客户不分产品行下预报单：产品明细里的国内快递单号是客户填的（没填才是「货拉拉」）；手填的整票体积不被尺寸盖掉、兜底行不带尺寸", async () => {
      // 页面在不分产品行时也会把整票长宽高带上来（算体积用）；客户手填了实际体积 0.5 方
      const r = await call("POST /client/prealerts", C1, { warehouseId: "wh_yiwu_01", itemName: "鞋", packageCount: 3, transportMode: "sea", domesticTrackingNo: "YT123456", lengthCm: "20", widthCm: 30, heightCm: 40, volumeM3: 0.5 });
      assert.equal(r.status, 200, r.message);
      const order = await pm.order.findFirst({ where: { companyId: CO, domesticTrackingNo: "YT123456" }, include: { products: true, shipments: true } });
      assert.ok(order, "订单没建出来");
      assert.equal(order.products.length, 1);
      assert.equal(order.products[0].domesticTrackingNo, "YT123456", `产品明细里的单号是 ${order.products[0].domesticTrackingNo}`);
      // 兜底行不带尺寸（带了的话派送单导出等地方会按尺寸重算方数，CLAUDE.md 第 33 条）；整票体积就是客户填的 0.5
      assert.deepEqual([order.products[0].lengthCm, order.products[0].widthCm, order.products[0].heightCm], [null, null, null]);
      assert.equal(Number(order.volumeM3), 0.5, `订单体积被改成了 ${order.volumeM3}（客户填的是 0.5）`);
      assert.equal(Number(order.shipments[0].volumeM3), 0.5, `运单体积被改成了 ${order.shipments[0].volumeM3}`);
      const r2 = await call("POST /client/prealerts", C1, { warehouseId: "wh_yiwu_01", itemName: "包", packageCount: 1, transportMode: "sea" });
      assert.equal(r2.status, 200, r2.message);
      const o2 = await pm.order.findFirst({ where: { companyId: CO, itemName: "包" }, include: { products: true } });
      assert.equal(o2.products[0].domesticTrackingNo, "货拉拉", "没填单号时应该是默认的「货拉拉」");
    });

    await check("S5b 国内快递单号写成数字照样收下（原来 .trim() 抛错 500）、别的类型给中文提示；产品行尺寸 / 单箱重量写成数字字符串照样收下（原来写库 500）", async () => {
      const num = await call("POST /client/prealerts", C1, { warehouseId: "wh_yiwu_01", itemName: "数字单号", packageCount: 1, transportMode: "sea", domesticTrackingNo: 12345 });
      assert.equal(num.status, 200, `数字单号：${num.status} ${num.message}`);
      const o = await pm.order.findFirst({ where: { companyId: CO, itemName: "数字单号" }, include: { products: true } });
      assert.equal(o.products[0].domesticTrackingNo, "12345");
      const bad = await call("POST /client/prealerts", C1, { warehouseId: "wh_yiwu_01", itemName: "对象单号", packageCount: 1, transportMode: "sea", domesticTrackingNo: { a: 1 } });
      assert.equal(bad.status, 400, `对象单号：${bad.status} ${bad.message}`);
      assert.match(bad.message, /国内快递单号/);
      // 18 位长单号当数字传：JSON 解析时末几位已经变了，不许存成一个错单号；按文字传的原样存（Codex 复查 2026-09-30）
      for (const [label, extra] of [
        ["整单长单号", { domesticTrackingNo: 123456789012345678 }],
        ["产品行长单号", { products: [{ itemName: "产品行长单号", packageCount: 1, domesticTrackingNo: 123456789012345678 }] }],
        ["负数单号", { domesticTrackingNo: -5 }],
        ["小数单号", { domesticTrackingNo: 12.5 }],
      ] as const) {
        const r = await call("POST /client/prealerts", C1, { warehouseId: "wh_yiwu_01", itemName: label, packageCount: 1, transportMode: "sea", ...extra });
        assert.equal(r.status, 400, `${label}应该拦下：${r.status} ${r.message}`);
        assert.match(r.message, /国内快递单号请按文字填写/, `${label}的提示要说清怎么改：${r.message}`);
        assert.equal(await pm.order.count({ where: { companyId: CO, itemName: label } }), 0, `${label}拦了还是建了单`);
      }
      const longStr = await call("POST /client/prealerts", C1, { warehouseId: "wh_yiwu_01", itemName: "文字长单号", packageCount: 1, transportMode: "sea", domesticTrackingNo: "123456789012345678" });
      assert.equal(longStr.status, 200, `文字长单号：${longStr.status} ${longStr.message}`);
      const lo = await pm.order.findFirst({ where: { companyId: CO, itemName: "文字长单号" }, include: { products: true } });
      assert.equal(lo.products[0].domesticTrackingNo, "123456789012345678", "按文字传的长单号被改了");
      const staffNum = await call("POST /staff/orders", STAFF, { clientId: C1.userId, trackingNo: "ZZSC29DN1", warehouseId: "wh_yiwu_01", itemName: "员工数字单号", packageCount: 2, transportMode: "sea", arrivedAt: "2026-09-20", domesticTrackingNo: 67890, volumeM3: 0.8 });
      assert.equal(staffNum.status, 200, `员工数字单号：${staffNum.status} ${staffNum.message}`);
      const so = await pm.order.findFirst({ where: { companyId: CO, itemName: "员工数字单号" }, include: { products: true } });
      assert.equal(so.products[0].domesticTrackingNo, "67890");
      assert.equal(Number(so.volumeM3), 0.8);
      for (const [who, path, auth, extra] of [["客户", "POST /client/prealerts", C1, {}], ["员工", "POST /staff/orders", STAFF, { clientId: C1.userId, trackingNo: "ZZSC29STR1", arrivedAt: "2026-09-20" }]] as const) {
        const r = await call(path, auth as Auth, { warehouseId: "wh_yiwu_01", itemName: `${who}字符串尺寸`, packageCount: 1, transportMode: "sea", ...extra, products: [{ itemName: `${who}字符串尺寸`, packageCount: 1, lengthCm: "12", widthCm: "20", heightCm: "30", weightKg: "1.25" }] });
        assert.equal(r.status, 200, `${who}产品行尺寸写成数字字符串：${r.status} ${r.message}`);
        const row = await pm.orderProduct.findFirst({ where: { itemName: `${who}字符串尺寸` } });
        assert.deepEqual([row.lengthCm, row.widthCm, row.heightCm, Number(row.weightKg)], [12, 20, 30, 1.25]);
      }
    });

    // ---------- S6 ----------
    const product = (name: string, extra: Row = {}) => ({ productName: name, packageCount: 1, quantityPerBox: 1, unitWeightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10, material: "布", cargoValue: "10", cargoType: "normal", ...extra });
    const task = await call("POST /client/consolidation/tasks", C1, { destinationTh: "曼谷" });
    const taskRow = await pm.consolidationTask.findFirst({ where: { companyId: CO, clientId: C1.userId }, orderBy: { createdAt: "desc" } });
    await check("S6 普通集货编辑预报单：旧页面上的一行已经被别人删了 → 整次不存（409），货物明细一行不少；客户编辑、超管强制编辑两条路都这样", async () => {
      assert.equal(task.status, 200, task.message);
      for (const who of ["client", "admin"] as const) {
        const pa = await call("POST /client/consolidation/prealerts", C1, { taskId: taskRow.id, mark: `M${who}`, products: [product("甲"), product("乙")] });
        assert.equal(pa.status, 200, pa.message);
        const paRow = await pm.consolidationPrealert.findFirst({ where: { taskId: taskRow.id, mark: `M${who}` }, include: { products: { orderBy: { sortOrder: "asc" } } } });
        const [jia, yi] = paRow.products;
        // 页面一：保存「甲、丙」（删了乙、加了丙）
        const edit = who === "client" ? "POST /client/consolidation/prealerts/update" : "POST /admin/consolidation/prealerts/force-edit";
        const actor = who === "client" ? C1 : ADMIN;
        const p1 = await call(edit, actor, { prealertId: paRow.id, products: [{ id: jia.id, ...product("甲") }, product("丙")] });
        assert.equal(p1.status, 200, `${who} 第一次保存失败：${p1.message}`);
        // 页面二（没刷新）：拿着旧的「甲、乙」保存
        const p2 = await call(edit, actor, { prealertId: paRow.id, products: [{ id: jia.id, ...product("甲2") }, { id: yi.id, ...product("乙") }] });
        assert.equal(p2.status, 409, `${who} 旧页面保存没挡住（${p2.status}）：${p2.message}`);
        assert.match(p2.message, /刷新/, p2.message);
        const after = await pm.consolidationPrealertProduct.findMany({ where: { prealertId: paRow.id }, orderBy: { sortOrder: "asc" } });
        assert.deepEqual(after.map((x: Row) => x.productName), ["甲", "丙"], `${who} 明细被改了：${after.map((x: Row) => x.productName)}`);
      }
    });

    // ---------- S7 ----------
    await check("S7 两个人同时删同一件货物（普通版、仓库版）、同一张订单：后一个给提示，不是 500", async () => {
      // 普通版：一张 3 件货的预报单，两个人同时删第一件
      const pa = await call("POST /client/consolidation/prealerts", C1, { taskId: taskRow.id, mark: "DEL", products: [product("一"), product("二"), product("三")] });
      assert.equal(pa.status, 200, pa.message);
      const paRow = await pm.consolidationPrealert.findFirst({ where: { taskId: taskRow.id, mark: "DEL" }, include: { products: true } });
      const target = paRow.products[0].id;
      const both = await Promise.all([
        call("POST /admin/consolidation/prealerts/product-delete", ADMIN, { productId: target }),
        call("POST /admin/consolidation/prealerts/product-delete", ADMIN, { productId: target }),
      ]);
      const codes = both.map((r) => r.status).sort();
      assert.ok(codes.includes(200), `两个都没删成：${JSON.stringify(both)}`);
      assert.ok(!codes.includes(500), `有一个 500：${JSON.stringify(both)}`);
      assert.equal(await pm.consolidationPrealertProduct.count({ where: { prealertId: paRow.id } }), 2);

      // 仓库版
      const plan = await call("POST /admin/whr-consolidation/plans", ADMIN, { destinationTh: "曼谷", totalVolumeM3: 68, customers: [{ clientId: C1.userId, unitPriceNormal: 100, unitPriceInspection: 200, unitPriceSensitive: 300 }] });
      assert.equal(plan.status, 200, plan.message);
      assert.equal((await call("POST /client/whr-consolidation/address", C1, { planId: plan.data.id, deliveryAddress: "曼谷一号" })).status, 200);
      const wpa = await call("POST /client/whr-consolidation/prealerts", C1, { planId: plan.data.id, mark: "W" });
      assert.equal(wpa.status, 200, wpa.message);
      const item = (n: string) => ({ productName: n, packageCount: 1, quantityPerBox: 1, lengthCm: 10, widthCm: 10, heightCm: 10, unitWeightKg: 1, material: "布", cargoValue: "10", cargoType: "normal" });
      const items = await call("POST /client/whr-consolidation/prealerts/items", C1, { prealertId: wpa.data.id, items: [item("一"), item("二"), item("三")] });
      assert.equal(items.status, 200, items.message);
      const witems = await pm.whrConsolidationPrealertItem.findMany({ where: { prealertId: wpa.data.id } });
      const wboth = await Promise.all([
        call("POST /admin/whr-consolidation/prealerts/item-delete", ADMIN, { itemId: witems[0].id }),
        call("POST /admin/whr-consolidation/prealerts/item-delete", ADMIN, { itemId: witems[0].id }),
      ]);
      const wcodes = wboth.map((r) => r.status);
      assert.ok(wcodes.includes(200), `仓库版两个都没删成：${JSON.stringify(wboth)}`);
      assert.ok(!wcodes.includes(500), `仓库版有一个 500：${JSON.stringify(wboth)}`);

      // 同一张订单
      await mkOrder("zz_sc29_o7");
      await mkShip("zz_sc29_s7", "zz_sc29_o7", "ZZSC29S7", "inWarehouseCN");
      const obot = await Promise.all([
        call("POST /admin/orders/delete", ADMIN, { orderId: "zz_sc29_o7" }),
        call("POST /admin/orders/delete", ADMIN, { orderId: "zz_sc29_o7" }),
      ]);
      const ocodes = obot.map((r) => r.status);
      assert.ok(ocodes.includes(200), `订单两个都没删成：${JSON.stringify(obot)}`);
      assert.ok(!ocodes.includes(500), `删订单有一个 500：${JSON.stringify(obot)}`);
      assert.equal(await pm.order.count({ where: { id: "zz_sc29_o7" } }), 0);
    });

    // ---------- S8 ----------
    await check("S8 整柜装柜日期：北京时间的明天挡住、今天放行；看板「本月」算上北京时间 1 号凌晨建的柜", async () => {
      const bjToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
      const bjTomorrow = new Date(Date.now() + 8 * 3600_000 + 86400_000).toISOString().slice(0, 10);
      const mk = (bl: string, cn: string, loadingDate: string) => call("POST /staff/fcl-containers/create", STAFF, {
        clientId: C1.userId, trackingNo: bl, containerNo: cn, containerType: "40HQ", transportMode: "sea", warehouseId: "wh_yiwu_01",
        loadingDate, amountCny: "1", remark: "",
        products: [{ itemName: "鞋", packageCount: 1, quantityPerBox: 1, lengthCm: 10, widthCm: 10, heightCm: 10, unitWeightKg: 1, domesticTrackingNo: "SF", cargoType: "normal" }],
      });
      const tomorrow = await mk("ZZSC29BL8A", "ZZSC29CN8A", bjTomorrow);
      assert.equal(tomorrow.status, 400, `北京时间的明天（${bjTomorrow}）照样收了`);
      assert.match(tomorrow.message, /未来/, tomorrow.message);
      const today = await mk("ZZSC29BL8B", "ZZSC29CN8B", bjToday);
      assert.equal(today.status, 200, `北京时间的今天（${bjToday}）被挡了：${today.message}`);
      // 把它的创建时间改成「北京时间本月 1 号 00:30」
      const bj = new Date(Date.now() + 8 * 3600_000);
      const firstMorning = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), 1, 0, 30) - 8 * 3600_000);
      await pm.container.update({ where: { id: today.data.containerId }, data: { createdAt: firstMorning } });
      const ov = await call("GET /staff/fcl-containers/overview", STAFF);
      assert.equal(ov.status, 200, ov.message);
      const s = JSON.stringify(ov.data);
      const thisMonth = ov.data?.thisMonth ?? ov.data?.stats?.thisMonth;
      assert.ok(typeof thisMonth === "number", `看板没有 thisMonth：${s.slice(0, 200)}`);
      const allFcl = await pm.container.findMany({ where: { companyId: CO, isFcl: true }, select: { createdAt: true } });
      const bjMonthStart = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), 1) - 8 * 3600_000);
      const expected = allFcl.filter((c: Row) => c.createdAt >= bjMonthStart).length;
      assert.equal(thisMonth, expected, `本月应该 ${expected} 个（含 1 号凌晨那个），看板说 ${thisMonth}`);
    });

    // ---------- S9 ----------
    await check("S9 同一客户同一刻新增两个默认地址：最后只有一个默认", async () => {
      const addr = (n: string) => ({ contactName: n, contactPhone: "0800000000", addressDetail: `曼谷 ${n}`, isDefault: true });
      const both = await Promise.all([call("POST /client/addresses", C2, addr("甲")), call("POST /client/addresses", C2, addr("乙"))]);
      both.forEach((r) => assert.equal(r.status, 200, r.message));
      const defaults = await pm.clientAddress.count({ where: { companyId: CO, clientId: C2.userId, isDefault: 1 } });
      assert.equal(defaults, 1, `有 ${defaults} 个默认地址`);
    });

    // ---------- S10 ----------
    await check("S10 客户专属价格：有一个价格存不下 → 整次不存、旧价格还在；同时保存两次 → 不会存出两套", async () => {
      const ok1 = await call("POST /admin/shipping/client-config", ADMIN, { clientId: C1.userId, prices: { "sea|normal": 321 } });
      assert.equal(ok1.status, 200, ok1.message);
      const bad = await call("POST /admin/shipping/client-config", ADMIN, { clientId: C1.userId, prices: { "sea|normal": 111, "land|normal": 1e20 } });
      assert.equal(bad.status, 400, `存不下的价格没挡住（${bad.status}）：${bad.message}`);
      const rows = await pm.pricingRule.findMany({ where: { companyId: CO, customerId: C1.userId } });
      assert.deepEqual(rows.map((r: Row) => `${r.transportMode}|${r.cargoType}=${Number(r.unitPriceCny)}`), ["sea|normal=321"], `旧价格没了：${JSON.stringify(rows)}`);
      const prices = { "sea|normal": 1, "sea|inspection": 2, "sea|sensitive": 3, "land|normal": 4, "land|inspection": 5, "land|sensitive": 6 };
      const both = await Promise.all([
        call("POST /admin/shipping/client-config", ADMIN, { clientId: C1.userId, prices }),
        call("POST /admin/shipping/client-config", ADMIN, { clientId: C1.userId, prices }),
      ]);
      both.forEach((r) => assert.equal(r.status, 200, r.message));
      assert.equal(await pm.pricingRule.count({ where: { companyId: CO, customerId: C1.userId } }), 6, "同时保存存出了两套价格");
    });

    // ---------- S11 ----------
    await check("S11 没填体积的货：整票装柜 / 部分装柜 / 部分卸 / 整票卸，体积一直是「没填」，不被写成 0", async () => {
      const ctr = await call("POST /staff/loading-manifests", STAFF, { warehouse: "wh_yiwu_01", transportMode: "sea", containerNo: "ZZSC29CTR11", carrierInfo: "承运" });
      assert.equal(ctr.status, 200, ctr.message);
      const ctrId = ctr.data?.manifest?.id ?? ctr.data?.id;
      await mkOrder("zz_sc29_o11");
      await mkShip("zz_sc29_s11", "zz_sc29_o11", "ZZSC29S11", "inWarehouseCN", { volumeM3: null });
      const load = await call("POST /staff/loading-manifests/add-shipment", STAFF, { trackingNo: "ZZSC29S11", pieceCount: 4 }, { id: ctrId });
      assert.equal(load.status, 200, load.message);
      const parent = await pm.shipment.findUnique({ where: { id: "zz_sc29_s11" } });
      const child = await pm.shipment.findFirst({ where: { parentTrackingNo: "ZZSC29S11" } });
      assert.equal(parent.volumeM3, null, `父单体积被写成 ${parent.volumeM3}`);
      assert.equal(child.volumeM3, null, `子单体积被写成 ${child.volumeM3}`);
      assert.equal(child.packageCount, 4);
      const item = await pm.shipmentContainerItem.findFirst({ where: { shipmentId: child.id } });
      const part = await call("POST /staff/loading-manifests/remove-shipment", STAFF, { itemId: item.id, pieceCount: 2 });
      assert.equal(part.status, 200, part.message);
      assert.equal((await pm.shipment.findUnique({ where: { id: child.id } })).volumeM3, null, "部分卸以后子单体积变成数了");
      assert.equal((await pm.shipment.findUnique({ where: { id: "zz_sc29_s11" } })).volumeM3, null, "部分卸以后父单体积变成数了");
      const full = await call("POST /staff/loading-manifests/remove-shipment", STAFF, { itemId: item.id });
      assert.equal(full.status, 200, full.message);
      const p2 = await pm.shipment.findUnique({ where: { id: "zz_sc29_s11" } });
      assert.equal(p2.volumeM3, null, `整票卸完父单体积被写成 ${p2.volumeM3}`);
      assert.equal(p2.packageCount, 10, "件数没还全");
      // 填了体积的照旧按比例扣和还（不误伤）
      await mkOrder("zz_sc29_o11b");
      await mkShip("zz_sc29_s11b", "zz_sc29_o11b", "ZZSC29S11B", "inWarehouseCN", { volumeM3: 1 });
      const load2 = await call("POST /staff/loading-manifests/add-shipment", STAFF, { trackingNo: "ZZSC29S11B", pieceCount: 4 }, { id: ctrId });
      assert.equal(load2.status, 200, load2.message);
      assert.equal(Number((await pm.shipment.findUnique({ where: { id: "zz_sc29_s11b" } })).volumeM3), 0.6);
      assert.equal(Number((await pm.shipment.findFirst({ where: { parentTrackingNo: "ZZSC29S11B" } })).volumeM3), 0.4);
    });

    // ---------- S12 ----------
    await check("S12 仓库版计划详情：每张预报单带上「一共几条日志」（只给最近 50 条）", async () => {
      const plan = await call("POST /admin/whr-consolidation/plans", ADMIN, { destinationTh: "曼谷", totalVolumeM3: 68, customers: [{ clientId: C2.userId, unitPriceNormal: 100, unitPriceInspection: 200, unitPriceSensitive: 300 }] });
      assert.equal(plan.status, 200, plan.message);
      assert.equal((await call("POST /client/whr-consolidation/address", C2, { planId: plan.data.id, deliveryAddress: "曼谷二号" })).status, 200);
      const wpa = await call("POST /client/whr-consolidation/prealerts", C2, { planId: plan.data.id, mark: "L" });
      assert.equal(wpa.status, 200, wpa.message);
      for (let i = 0; i < 51; i++) {
        await pm.whrConsolidationStatusLog.create({ data: { prealertId: wpa.data.id, companyId: CO, operatorId: ADMIN.userId, operatorRole: "admin", operatorName: "x", fromStatus: "pending", toStatus: "pending", remark: `r${i}` } });
      }
      const d = await call("GET /admin/whr-consolidation/plans/detail", ADMIN, {}, { planId: plan.data.id });
      assert.equal(d.status, 200, d.message);
      const pa = d.data.customers.flatMap((c: Row) => c.prealerts).find((x: Row) => x.id === wpa.data.id);
      assert.equal(pa.statusLogs.length, 50);
      assert.ok(pa.statusLogTotal >= 51, `statusLogTotal = ${pa.statusLogTotal}`);
    });
  } finally {
    await cleanup();
    const left = await pm.user.count({ where: { companyId: CO } }) + await pm.shipment.count({ where: { companyId: CO } }) + await pm.order.count({ where: { companyId: CO } }) + await pm.container.count({ where: { companyId: CO } });
    console.log(`清理后残留：${left}`);
    await prisma.$disconnect();
  }
  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
