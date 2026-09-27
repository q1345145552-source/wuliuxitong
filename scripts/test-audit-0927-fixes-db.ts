/**
 * 2026-09-27 全系统审查修复 —— 连库回归（真 handler + 真 PostgreSQL）。
 *
 * 覆盖：
 *   #1  超管改拆过柜的单：列表给编辑框的是整票量；按整票保存后父单剩余不变；填得比已装走的还少 → 400 不写
 *   #2  员工手写在备注里的柜号：客户查轨迹（备注 + 下一站）/ 客户运单列表 / 派送签收单导出都抹成「柜号已隐藏」
 *   #3  派送单挂在子单上：父单轨迹接口 children[].lastmile 带出来
 *   #4  订单 received 后客户运单列表还看得到
 *   #12 预报单收货确认：仓库、发货日期真的存进订单和运单；仓库不合法 / 日期不存在 → 400
 *
 * 只连测试库：DATABASE_URL 不带 neon.tech 的不跑（一次性 docker 库设 AGENT_PORTAL_TEST_ALLOW_DB=1）；
 * 没有 DATABASE_URL 打印「跳过」。测试数据全在假公司 zz_a0927_co 下，开跑前、跑完后都清干净。
 */
import assert from "node:assert/strict";

type Row = Record<string, any>;
type Auth = { userId: string; companyId: string; role: string; name: string };
const CO = "zz_a0927_co";
const ADMIN: Auth = { userId: "zz_a0927_admin", companyId: CO, role: "admin", name: "审计超管" };
const STAFF: Auth = { userId: "zz_a0927_staff", companyId: CO, role: "staff", name: "审计员工" };
const CLIENT: Auth = { userId: "zz_a0927_client", companyId: CO, role: "client", name: "审计客户" };

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (!url.includes("neon.tech") && process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：DATABASE_URL 不是 Neon 测试库，怕连到生产库不跑（确认是测试库可设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  const { prisma } = await import("../apps/api/src/db/prisma");
  const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
  const pm: any = prisma;
  const { clearContainerNosCache } = await import("../apps/api/src/modules/core/container-nos");

  const routes = new Map<string, Function>();
  const app: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) app[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
  (await import("../apps/api/src/modules/admin/routes")).registerAdminRoutes(app);
  (await import("../apps/api/src/modules/orders/routes")).registerOrderRoutes(app);
  (await import("../apps/api/src/modules/containers/routes")).registerContainerRoutes(app);
  (await import("../apps/api/src/modules/shipments/routes")).registerShipmentRoutes(app);
  (await import("../apps/api/src/modules/admin-ops/routes")).registerAdminOpsRoutes(app);
  (await import("../apps/api/src/modules/agent-portal/routes")).registerAgentPortalRoutes(app);

  async function call(key: string, auth: Auth, body: Row = {}, query: Record<string, string> = {}): Promise<{ status: number; data: any; message: string }> {
    const handler = routes.get(key);
    if (!handler) return { status: 404, data: undefined, message: `没有这个接口：${key}` };
    let status = 200; let raw: any;
    const res: any = { status(s: number) { status = s; return res; }, json(p: any) { raw = p; }, setHeader() {} };
    try { await handler({ body, query, headers: {}, auth }, res); }
    catch (e) { if (e instanceof BusinessError) { status = e.httpStatus; raw = { code: e.code, message: e.message }; } else throw e; }
    return { status, data: raw?.data, message: raw?.message ?? "" };
  }

  async function cleanup(): Promise<void> {
    const cs = await pm.container.findMany({ where: { companyId: CO }, select: { id: true } });
    const ids = cs.map((c: Row) => c.id);
    await pm.adminLastmileOrder.deleteMany({ where: { companyId: CO } });
    await pm.shipmentContainerItem.deleteMany({ where: { containerId: { in: ids } } });
    await pm.container.deleteMany({ where: { companyId: CO } });
    await pm.statusLog.deleteMany({ where: { companyId: CO } });
    await pm.orderProductImage.deleteMany({ where: { companyId: CO } });
    await pm.orderProduct.deleteMany({ where: { companyId: CO } });
    await pm.shipment.deleteMany({ where: { companyId: CO } });
    await pm.order.deleteMany({ where: { companyId: CO } });
    await pm.auditLog.deleteMany({ where: { companyId: CO } });
    await pm.user.deleteMany({ where: { companyId: CO } });
    await pm.agent.deleteMany({ where: { id: "zz_a0927_agent" } });
  }

  let passed = 0, failed = 0;
  async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`✅ ${name}`); }
    catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
  }

  await cleanup();
  try {
    for (const u of [ADMIN, STAFF, CLIENT]) {
      await pm.user.create({ data: { id: u.userId, companyId: CO, role: u.role, name: u.name, passwordHash: "x", phone: `0${u.userId}`, status: "active" } });
    }
    const recv = { receiverNameTh: "r", receiverPhoneTh: "0", receiverAddressTh: "addr" };
    // 一张 100kg / 1.0 方 / 100 箱的单，装走 70（子单），父单剩 30
    const O1 = await pm.order.create({ data: { id: "zz_a0927_o1", companyId: CO, clientId: CLIENT.userId, warehouseId: "wh_yiwu_01", itemName: "鞋", productQuantity: 0, packageCount: 100, packageUnit: "box", transportMode: "sea", weightKg: 100, volumeM3: 1.0, approvalStatus: "approved", ...recv } });
    await pm.orderProduct.createMany({ data: [
      { companyId: CO, orderId: O1.id, itemName: "鞋A", packageCount: 50, lengthCm: 60, widthCm: 40, heightCm: 30, productQuantity: 10, sortOrder: 0 },
      { companyId: CO, orderId: O1.id, itemName: "鞋B", packageCount: 50, productQuantity: 10, sortOrder: 1 },
    ] });
    const SP = await pm.shipment.create({ data: { id: "zz_a0927_sp", companyId: CO, orderId: O1.id, trackingNo: "ZZA0927P1", currentStatus: "inWarehouseCN", warehouseId: "wh_yiwu_01", transportMode: "sea", packageCount: 30, weightKg: 30, volumeM3: 0.3, remark: "柜 MEDU1234567 已封" } });
    const SC = await pm.shipment.create({ data: { id: "zz_a0927_sc", companyId: CO, orderId: O1.id, trackingNo: "ZZA0927P1-1", parentTrackingNo: "ZZA0927P1", currentStatus: "delivering", warehouseId: "wh_yiwu_01", transportMode: "sea", packageCount: 70, weightKg: 70, volumeM3: 0.7, remark: "MEDU1234567 第二批" } });
    const C1 = await pm.container.create({ data: { companyId: CO, containerNo: "MEDU1234567", containerType: "40HQ", currentStatus: "SEALED", transportMode: "sea" } });
    await pm.shipmentContainerItem.create({ data: { shipmentId: SC.id, containerId: C1.id, loadedVolumeM3: 0.7, loadedPieceCount: 70 } });
    await pm.statusLog.create({ data: { id: "zz_a0927_log1", companyId: CO, shipmentId: SP.id, operatorId: STAFF.userId, operatorRole: "staff", fromStatus: "inWarehouseCN", toStatus: "loaded", remark: "柜号 MEDU1234567 已开船", nextStop: "MEDU1234567 泰国边境" } });
    // 子单自己的记录也可能带柜号（推柜子时写的）
    await pm.statusLog.create({ data: { id: "zz_a0927_log2", companyId: CO, shipmentId: SC.id, operatorId: STAFF.userId, operatorRole: "staff", fromStatus: "loaded", toStatus: "departed", remark: "MEDU1234567 今日开船" } });
    await pm.adminLastmileOrder.create({ data: { id: "zz_a0927_lm1", companyId: CO, deliveryNo: "ZZA0927D1", shipmentId: SC.id, carrierName: "测试车队", externalTrackingNo: "X1", status: "delivering", driverName: "张三", licensePlate: "京A12345", phoneNumber: "13800000000" } });

    // ---------- #1 ----------
    const productsPayload = [
      { itemName: "鞋A", packageCount: 50, lengthCm: 60, widthCm: 40, heightCm: 30, productQuantity: 10, cargoType: "normal", domesticTrackingNo: "货拉拉" },
      { itemName: "鞋B（改品名）", packageCount: 50, productQuantity: 10, cargoType: "normal", domesticTrackingNo: "货拉拉" },
    ];
    await check("#1a 超管列表给编辑框的 totalWeightKg / totalVolumeM3 是整票（100 / 1.0）", async () => {
      const r = await call("GET /admin/orders", ADMIN, {}, { pageSize: "500" });
      const it = (r.data?.items ?? []).find((x: Row) => x.trackingNo === "ZZA0927P1");
      assert.ok(it, "列表里没找到父单");
      assert.equal(Number(it.totalWeightKg), 100);
      assert.equal(Number(it.totalVolumeM3), 1);
    });
    await check("#1b 按整票（100 / 1.0）保存：订单还是 100 / 1.0，父单剩余还是 30 / 0.3", async () => {
      const r = await call("POST /admin/orders/update", ADMIN, { orderId: O1.id, products: productsPayload, packageCount: 100, weightKg: 100, volumeM3: 1.0 });
      assert.equal(r.status, 200, r.message);
      const o = await pm.order.findUnique({ where: { id: O1.id } });
      const sp = await pm.shipment.findUnique({ where: { id: SP.id } });
      assert.equal(Number(o.weightKg), 100); assert.equal(Number(o.volumeM3), 1);
      assert.equal(Number(sp.weightKg), 30); assert.equal(Number(sp.volumeM3), 0.3);
    });
    await check("#1c 填得比已装走的还少（30 < 已装 70）→ 400，且订单、父单一个字没改", async () => {
      const r = await call("POST /admin/orders/update", ADMIN, { orderId: O1.id, products: productsPayload, packageCount: 100, weightKg: 30, volumeM3: 0.3 });
      assert.equal(r.status, 400, `应该 400，实际 ${r.status} ${r.message}`);
      assert.match(r.message, /已经?装走|已装柜/,`提示语要说清是被已装走的量拦下：${r.message}`);
      const o = await pm.order.findUnique({ where: { id: O1.id } });
      const sp = await pm.shipment.findUnique({ where: { id: SP.id } });
      assert.equal(Number(o.weightKg), 100); assert.equal(Number(sp.weightKg), 30); assert.equal(Number(sp.volumeM3), 0.3);
    });
    await check("#1d 箱数填得比已装走的还少（50 < 已装 70）→ 400", async () => {
      const r = await call("POST /admin/orders/update", ADMIN, { orderId: O1.id, packageCount: 50 });
      assert.equal(r.status, 400, `应该 400，实际 ${r.status} ${r.message}`);
      const sp = await pm.shipment.findUnique({ where: { id: SP.id } });
      assert.equal(sp.packageCount, 30);
    });

    // ---------- #2 ----------
    await check("#2a 客户查轨迹：父单、子单记录里手写的柜号都抹掉", async () => {
      const r = await call("GET /client/shipments/track", CLIENT, {}, { trackingNo: "ZZA0927P1" });
      assert.equal(r.status, 200, r.message);
      const text = JSON.stringify(r.data);
      assert.ok(!text.includes("MEDU1234567"), `响应里还有柜号：${text.slice(0, 300)}`);
      const remarks = (r.data.timeline ?? []).map((l: Row) => l.remark);
      assert.ok(remarks.some((x: string) => x.includes("柜号已隐藏")), `应抹成「柜号已隐藏」：${JSON.stringify(remarks)}`);
    });
    await check("#2b 客户运单列表：运单备注、轨迹备注、latestRemark 都不带柜号", async () => {
      const r = await call("GET /client/orders", CLIENT, {}, {});
      const co = (r.data?.items ?? []).find((x: Row) => x.id === O1.id);
      assert.ok(co, "客户列表里没这张单");
      assert.ok(!JSON.stringify(co).includes("MEDU1234567"), `还带柜号：remark=${co.remark} latest=${co.latestRemark}`);
      assert.ok(String(co.remark).includes("柜号已隐藏"));
    });
    await check("#2d 客户查轨迹：「下一站」里手写的柜号也抹掉", async () => {
      const r = await call("GET /client/shipments/track", CLIENT, {}, { trackingNo: "ZZA0927P1" });
      const stops = (r.data.timeline ?? []).map((l: Row) => l.nextStop).filter(Boolean);
      assert.ok(stops.length > 0, "测试数据里的「下一站」没下发，这条等于没测");
      assert.ok(stops.every((x: string) => !x.includes("MEDU1234567")), `下一站还带柜号：${JSON.stringify(stops)}`);
      assert.ok(stops.some((x: string) => x.includes("柜号已隐藏")), `应抹成「柜号已隐藏」：${JSON.stringify(stops)}`);
    });
    await check("#2e 派送签收单导出（给客户签字的那张）：子单备注里的柜号抹掉", async () => {
      const r = await call("GET /admin/lastmile/customer-export-data", STAFF, {}, { deliveryNo: "ZZA0927D1", clientId: CLIENT.userId });
      assert.equal(r.status, 200, r.message);
      const line = (r.data?.customers?.[0]?.shipments ?? []).find((x: Row) => x.trackingNo === "ZZA0927P1-1");
      assert.ok(line, `导出数据里没这张子单：${JSON.stringify(r.data).slice(0, 200)}`);
      assert.ok(!String(line.remark).includes("MEDU1234567"), `签收单备注还带柜号：${line.remark}`);
      assert.ok(String(line.remark).includes("柜号已隐藏"), `应抹成「柜号已隐藏」：${line.remark}`);
    });
    await check("#2f 卸过柜（柜内记录删了）以后，备注里原来那个柜号照样抹；手写的标准柜号（系统里没录过、中间带空格）也抹", async () => {
      await pm.statusLog.create({ data: { id: "zz_a0927_log3", companyId: CO, shipmentId: SP.id, operatorId: STAFF.userId, operatorRole: "staff", fromStatus: "loaded", toStatus: "loaded", remark: "换柜 TGHU 8812345 明天走" } });
      // 不是标准柜号样子的（线上「Y + 10 位数字」那种），这票货也从没装过它 —— 只能靠「本公司全部柜号」那一道抹
      const cOther = await pm.container.create({ data: { companyId: CO, containerNo: "Y2609280001", containerType: "40HQ", currentStatus: "LOADING", transportMode: "sea" } });
      await pm.statusLog.create({ data: { id: "zz_a0927_log5", companyId: CO, shipmentId: SP.id, operatorId: STAFF.userId, operatorRole: "staff", fromStatus: "loaded", toStatus: "loaded", remark: "原计划装 Y2609280001" , nextStop: "Y2609280001 集港" } });
      const saved = await pm.shipmentContainerItem.findMany({ where: { shipmentId: SC.id } });
      await pm.shipmentContainerItem.deleteMany({ where: { shipmentId: SC.id } });
      clearContainerNosCache();
      try {
        const r = await call("GET /client/shipments/track", CLIENT, {}, { trackingNo: "ZZA0927P1" });
        const text = JSON.stringify(r.data);
        assert.ok(!text.includes("MEDU1234567"), "卸柜后原来那个柜号又露出来了");
        assert.ok(!/TGHU\s?8812345/.test(text), "手写的标准柜号露出来了");
        assert.ok(!text.includes("Y2609280001"), "本公司别的柜号（不是标准样子的）露出来了");
        const list = await call("GET /client/orders", CLIENT, {}, {});
        assert.ok(!JSON.stringify(list.data).includes("MEDU1234567"), "客户运单列表里卸柜后的柜号露出来了");
        assert.ok(!JSON.stringify(list.data).includes("Y2609280001"), "客户运单列表里别的柜号露出来了");
      } finally {
        await pm.statusLog.delete({ where: { id: "zz_a0927_log5" } });
        await pm.container.delete({ where: { id: cOther.id } });
        for (const it of saved) await pm.shipmentContainerItem.create({ data: { shipmentId: it.shipmentId, containerId: it.containerId, loadedVolumeM3: it.loadedVolumeM3, loadedPieceCount: it.loadedPieceCount } });
        await pm.statusLog.delete({ where: { id: "zz_a0927_log3" } });
      }
    });
    await check("#2g 柜号跟某张运单号一模一样的（线上 24 个「JL…」那种）不抹：那本来就是客户看得到的运单号", async () => {
      const cSame = await pm.container.create({ data: { companyId: CO, containerNo: "ZZA0927P1-1", containerType: "40HQ", currentStatus: "SEALED", transportMode: "sea" } });
      await pm.statusLog.create({ data: { id: "zz_a0927_log4", companyId: CO, shipmentId: SP.id, operatorId: STAFF.userId, operatorRole: "staff", fromStatus: "loaded", toStatus: "loaded", remark: "子单 ZZA0927P1-1 已分出" } });
      clearContainerNosCache();
      try {
        const r = await call("GET /client/shipments/track", CLIENT, {}, { trackingNo: "ZZA0927P1" });
        const remarks = (r.data.timeline ?? []).map((l: Row) => l.remark);
        assert.ok(remarks.some((x: string) => x.includes("子单 ZZA0927P1-1 已分出")), `运单号被当成柜号抹了：${JSON.stringify(remarks)}`);
      } finally {
        await pm.statusLog.delete({ where: { id: "zz_a0927_log4" } });
        await pm.container.delete({ where: { id: cSame.id } });
        clearContainerNosCache();
      }
    });
    await check("#2c 员工查同一票：备注原样（只对客户抹）", async () => {
      const r = await call("GET /client/shipments/track", STAFF, {}, { trackingNo: "ZZA0927P1" });
      assert.ok(JSON.stringify(r.data.timeline).includes("MEDU1234567"));
    });

    // ---------- #3 ----------
    await check("#3 派送单挂在子单上：父单轨迹接口 children[0].lastmile 带司机；父单自己 lastmile 仍为 null", async () => {
      const r = await call("GET /client/shipments/track", CLIENT, {}, { trackingNo: "ZZA0927P1" });
      assert.equal(r.data.lastmile, null);
      assert.ok(Array.isArray(r.data.children) && r.data.children.length === 1);
      assert.equal(r.data.children[0].lastmile?.driverName, "张三");
      assert.equal(r.data.children[0].lastmile?.licensePlate, "京A12345");
    });

    await check("#3b 代理看父单轨迹：子单页签也带派送信息（Codex 复核第 10 条，客户那边修了、代理这边漏了）；派送单号不给代理", async () => {
      await pm.agent.create({ data: { id: "zz_a0927_agent", companyId: CO, name: "测试代理", priceNormal: 1, priceInspection: 1, priceSensitive: 1 } });
      await pm.user.update({ where: { id: CLIENT.userId }, data: { agentId: "zz_a0927_agent" } });
      try {
        const AG: any = { userId: "zz_a0927_agent_user", companyId: CO, role: "agent", name: "测试代理", agentId: "zz_a0927_agent" };
        const r = await call("GET /agent/shipments/track", AG, {}, { trackingNo: "ZZA0927P1" });
        assert.equal(r.status, 200, r.message);
        assert.equal(r.data.lastmile, null);
        assert.equal(r.data.children?.[0]?.lastmile?.driverName, "张三");
        assert.equal(r.data.children?.[0]?.lastmile?.licensePlate, "京A12345");
        const text = JSON.stringify(r.data);
        assert.ok(!text.includes("ZZA0927D1"), "派送单号给了代理（能串到别人家的货）");
        assert.ok(!text.includes("zz_a0927_sc"), "子单的内部 id 下发了");
      } finally {
        await pm.user.update({ where: { id: CLIENT.userId }, data: { agentId: null } });
      }
    });

    // ---------- #4 ----------
    await check("#4 订单 received 后客户运单列表还看得到", async () => {
      await pm.order.update({ where: { id: O1.id }, data: { approvalStatus: "received" } });
      const r = await call("GET /client/orders", CLIENT, {}, {});
      assert.ok((r.data?.items ?? []).some((x: Row) => x.id === O1.id), `received 的单在客户列表里消失了（total=${r.data?.total}）`);
      await pm.order.update({ where: { id: O1.id }, data: { approvalStatus: "approved" } });
    });

    // ---------- #12 ----------
    const O2 = await pm.order.create({ data: { id: "zz_a0927_o2", companyId: CO, clientId: CLIENT.userId, warehouseId: "wh_yiwu_01", itemName: "包", productQuantity: 0, packageCount: 5, packageUnit: "box", transportMode: "sea", approvalStatus: "shipped", shipDate: "2026-09-01", ...recv } });
    const S2 = await pm.shipment.create({ data: { id: "zz_a0927_s2", companyId: CO, orderId: O2.id, trackingNo: "ZZA0927P2", currentStatus: "created", warehouseId: "wh_yiwu_01", transportMode: "sea", packageCount: 5 } });
    await check("#12a 收货确认传仓库 + 发货日期：订单和运单的仓库改成广州、发货日期改了", async () => {
      const r = await call("POST /staff/prealerts/receive", STAFF, { orderId: O2.id, itemName: "包", packageCount: 5, packageUnit: "box", transportMode: "sea", warehouseId: "wh_guangzhou_01", shipDate: "2026-01-05" });
      assert.equal(r.status, 200, r.message);
      const o = await pm.order.findUnique({ where: { id: O2.id } });
      const s = await pm.shipment.findUnique({ where: { id: S2.id } });
      assert.equal(o.warehouseId, "wh_guangzhou_01"); assert.equal(o.shipDate, "2026-01-05");
      assert.equal(s.warehouseId, "wh_guangzhou_01");
      assert.equal(o.approvalStatus, "received");
    });
    const O3 = await pm.order.create({ data: { id: "zz_a0927_o3", companyId: CO, clientId: CLIENT.userId, warehouseId: "wh_yiwu_01", itemName: "帽", productQuantity: 0, packageCount: 5, packageUnit: "box", transportMode: "sea", approvalStatus: "shipped", shipDate: "2026-09-01", ...recv } });
    await pm.shipment.create({ data: { id: "zz_a0927_s3", companyId: CO, orderId: O3.id, trackingNo: "ZZA0927P3", currentStatus: "created", warehouseId: "wh_yiwu_01", transportMode: "sea", packageCount: 5 } });
    await check("#12b 仓库不在四个之内 → 400 且没确认收货", async () => {
      const r = await call("POST /staff/prealerts/receive", STAFF, { orderId: O3.id, packageCount: 5, warehouseId: "wh_bad_99" });
      assert.equal(r.status, 400, `应 400，实际 ${r.status} ${r.message}`);
      const o = await pm.order.findUnique({ where: { id: O3.id } });
      assert.equal(o.approvalStatus, "shipped"); assert.equal(o.warehouseId, "wh_yiwu_01");
    });
    await check("#12c 发货日期不存在（2026-02-31）→ 400", async () => {
      const r = await call("POST /staff/prealerts/receive", STAFF, { orderId: O3.id, packageCount: 5, shipDate: "2026-02-31" });
      assert.equal(r.status, 400, `应 400，实际 ${r.status} ${r.message}`);
      const o = await pm.order.findUnique({ where: { id: O3.id } });
      assert.equal(o.shipDate, "2026-09-01");
    });
    await check("#12d 不传仓库、日期：照旧不动（没传 = 不改）", async () => {
      const r = await call("POST /staff/prealerts/receive", STAFF, { orderId: O3.id, packageCount: 5 });
      assert.equal(r.status, 200, r.message);
      const o = await pm.order.findUnique({ where: { id: O3.id } });
      assert.equal(o.warehouseId, "wh_yiwu_01"); assert.equal(o.shipDate, "2026-09-01"); assert.equal(o.approvalStatus, "received");
    });
  } finally {
    await cleanup();
    await pm.$disconnect();
  }
  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
