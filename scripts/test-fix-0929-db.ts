/**
 * 2026-09-29 在测试库真跑（4 个测试员 + dsh）查出来、老板三个问题都选 A 之后修的 —— 连库回归（真 handler + 真 PostgreSQL）。
 * 每条都是「改回去就红」。
 *
 *   F1 已经排了尾端派送的货不许卸柜（老板选 A）：已签收的 / 派送中的 / 部分卸都挡，派送单、签收图、子单一样不少
 *      （原来照卸：子单一删，派送单、签收图、轨迹顺着外键一起没了）；「删柜子」走同一个卸柜函数，也挡
 *   F2 卸柜件数比已装件数多 → 400「超过」，什么都不动（原来按整票卸）；等于已装件数照常整票卸
 *   F3 单号只往上加、删了不回收（老板选 A，新表 number_sequences）：发号函数本身 + 集货任务号 JH + 派送单号 WD 端到端
 *   F4 仓库版集货：客户名下只剩已取消的预报单 → 能移除客户（原来提示先取消、取消完还是挡）
 *   F5 仓库版集货：柜子「装柜中」以后客户又报一票 → 柜子回「集货中」（原来一直停在装柜中）
 *   F6 仓库版集货：员工写在取消原因 / 时间线备注里的柜号（标准样子的、本公司柜子表里的），客户看不到
 *   F7 集货任务被删了，客户再点开：404「不存在或已被删除」（原来 403「无权访问」）；别人的任务照旧 403
 *   F8 入库照片：约 3MB 的照片能传（原来 400 万字就挡、英文提示）；太大的给中文提示；运单产品图同样中文
 *
 * 只连测试库：DATABASE_URL 不带 neon.tech 的不跑（一次性 docker 库设 AGENT_PORTAL_TEST_ALLOW_DB=1）；
 * 没有 DATABASE_URL 打印「跳过」。测试数据全在假公司 zz_f29_co 下，开跑前、跑完后都清干净；
 * 号段表里测试用的 zz_f29_ 开头那几行也清掉（JH / WD 是全局号段，只会往上推，不回收也不影响别人）。
 */
import assert from "node:assert/strict";

type Row = Record<string, any>;
type Auth = { userId: string; companyId: string; role: string; name: string; agentId?: string | null };
const CO = "zz_f29_co";
const ADMIN: Auth = { userId: "zz_f29_admin", companyId: CO, role: "admin", name: "修复超管" };
const STAFF: Auth = { userId: "zz_f29_staff", companyId: CO, role: "staff", name: "修复员工" };
const C1: Auth = { userId: "ZZF29C1", companyId: CO, role: "client", name: "修复客户一" };
const C2: Auth = { userId: "ZZF29C2", companyId: CO, role: "client", name: "修复客户二" };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (!url.includes("neon.tech") && process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：DATABASE_URL 不是 Neon 测试库，怕连到生产库不跑（确认是测试库可设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  process.env.IMAGES_DIR = process.env.IMAGES_DIR || require("node:os").tmpdir() + "/zz_f29_images";
  const { prisma } = await import("../apps/api/src/db/prisma");
  const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
  const { nextSequenceValue } = await import("../apps/api/src/modules/core/number-sequence");
  const pm: any = prisma;

  const routes = new Map<string, Function>();
  const app: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) app[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
  (await import("../apps/api/src/modules/orders/routes")).registerOrderRoutes(app);
  (await import("../apps/api/src/modules/shipments/routes")).registerShipmentRoutes(app);
  (await import("../apps/api/src/modules/admin-ops/routes")).registerAdminOpsRoutes(app);
  (await import("../apps/api/src/modules/consolidation/routes")).registerConsolidationRoutes(app);
  (await import("../apps/api/src/modules/loading-manifests/routes")).registerLoadingManifestRoutes(app);
  (await import("../apps/api/src/modules/containers/routes")).registerContainerRoutes(app);
  (await import("../apps/api/src/modules/whr-consolidation/routes")).registerWhrConsolidationRoutes(app);
  (await import("../apps/api/src/modules/whr-consolidation/staff-routes")).registerWhrConsolidationStaffRoutes(app);
  (await import("../apps/api/src/modules/whr-consolidation/client-routes")).registerWhrConsolidationClientRoutes(app);

  async function call(key: string, auth: Auth, body: Row = {}, query: Record<string, string> = {}): Promise<{ status: number; data: any; message: string }> {
    const handler = routes.get(key);
    if (!handler) return { status: 404, data: undefined, message: `没有这个接口：${key}` };
    let status = 200; let raw: any;
    const res: any = { status(s: number) { status = s; return res; }, json(p: any) { raw = p; }, setHeader() {} };
    try { await handler({ body, query, headers: {}, auth: { agentId: null, ...auth } }, res); }
    catch (e) { if (e instanceof BusinessError) { status = e.httpStatus; raw = { code: e.code, message: e.message }; } else throw e; }
    return { status, data: raw?.data, message: raw?.message ?? "" };
  }

  async function cleanup(): Promise<void> {
    const cs = await pm.container.findMany({ where: { companyId: CO }, select: { id: true } });
    await pm.adminLastmileOrder.deleteMany({ where: { companyId: CO } });
    await pm.shipmentContainerItem.deleteMany({ where: { containerId: { in: cs.map((c: Row) => c.id) } } });
    await pm.container.deleteMany({ where: { companyId: CO } });
    await pm.staffInboundPhoto.deleteMany({ where: { companyId: CO } });
    await pm.statusLog.deleteMany({ where: { companyId: CO } });
    await pm.orderProductImage.deleteMany({ where: { companyId: CO } });
    await pm.orderProduct.deleteMany({ where: { companyId: CO } });
    await pm.shipment.deleteMany({ where: { companyId: CO } });
    await pm.order.deleteMany({ where: { companyId: CO } });
    await pm.consolidationStatusLog.deleteMany({ where: { companyId: CO } });
    await pm.consolidationTask.deleteMany({ where: { companyId: CO } });
    const plans = await pm.whrConsolidationPlan.findMany({ where: { companyId: CO }, select: { id: true } });
    const planIds = plans.map((p: Row) => p.id);
    await pm.whrConsolidationStatusLog.deleteMany({ where: { companyId: CO } });
    await pm.whrConsolidationPrealertItem.deleteMany({ where: { prealert: { planCustomer: { planId: { in: planIds } } } } });
    await pm.whrConsolidationPrealert.deleteMany({ where: { planCustomer: { planId: { in: planIds } } } });
    await pm.whrConsolidationPlanCustomer.deleteMany({ where: { planId: { in: planIds } } });
    await pm.whrConsolidationPlan.deleteMany({ where: { id: { in: planIds } } });
    await pm.consolidationBalanceLedger.deleteMany({ where: { companyId: CO } });
    await pm.clientWalletAccount.deleteMany({ where: { companyId: CO } });
    await pm.auditLog.deleteMany({ where: { companyId: CO } });
    await pm.user.deleteMany({ where: { companyId: CO } });
    await pm.$executeRawUnsafe(`DELETE FROM number_sequences WHERE name LIKE 'zz\\_f29\\_%'`);
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

    // ---------- F1 已排派送的货不许卸 ----------
    const ctrTh = await pm.container.create({ data: { companyId: CO, containerNo: "ZZF29TH1", containerType: "40HQ", currentStatus: "IN_WAREHOUSE_TH", transportMode: "sea" } });
    await mkOrder("zz_f29_o1");
    await mkShip("zz_f29_s1", "zz_f29_o1", "ZZF29S1", "inWarehouseTH", { packageCount: 0, volumeM3: 0, weightKg: 0 });
    await mkShip("zz_f29_s1c", "zz_f29_o1", "ZZF29S1-1", "delivered", { parentTrackingNo: "ZZF29S1", packageCount: 6, volumeM3: 0.6, weightKg: 60 });
    await mkShip("zz_f29_s1d", "zz_f29_o1", "ZZF29S1-2", "outForDelivery", { parentTrackingNo: "ZZF29S1", packageCount: 4, volumeM3: 0.4, weightKg: 40 });
    const itSigned = await pm.shipmentContainerItem.create({ data: { containerId: ctrTh.id, shipmentId: "zz_f29_s1c", loadedPieceCount: 6, loadedVolumeM3: 0.6 } });
    const itDeliv = await pm.shipmentContainerItem.create({ data: { containerId: ctrTh.id, shipmentId: "zz_f29_s1d", loadedPieceCount: 4, loadedVolumeM3: 0.4 } });
    await pm.adminLastmileOrder.create({ data: { id: "zz_f29_lm1", companyId: CO, deliveryNo: "ZZF29D1", shipmentId: "zz_f29_s1c", carrierName: "车队", externalTrackingNo: "X", status: "SIGNED", signImageBase64: PNG } });
    await pm.adminLastmileOrder.create({ data: { id: "zz_f29_lm2", companyId: CO, deliveryNo: "ZZF29D2", shipmentId: "zz_f29_s1d", carrierName: "车队", externalTrackingNo: "X", status: "DELIVERING" } });

    await check("F1 已签收的子单整票卸柜 → 挡住（提示先撤销签收），子单、派送单、签收图、柜内记录一样不少", async () => {
      const r = await call("POST /staff/loading-manifests/remove-shipment", STAFF, { itemId: itSigned.id });
      assert.notEqual(r.status, 200, "已签收的货照样卸掉了");
      assert.match(r.message, /签收/, `提示里没说是已签收：${r.message}`);
      assert.match(r.message, /ZZF29D1/, `提示里没写派送单号：${r.message}`);
      assert.ok(await pm.shipment.findUnique({ where: { id: "zz_f29_s1c" } }), "子单被删了");
      const lm = await pm.adminLastmileOrder.findUnique({ where: { id: "zz_f29_lm1" } });
      assert.equal(lm?.signImageBase64, PNG, "派送单或签收图没了");
      assert.ok(await pm.shipmentContainerItem.findUnique({ where: { id: itSigned.id } }), "柜内记录被删了");
      const parent = await pm.shipment.findUnique({ where: { id: "zz_f29_s1" } });
      assert.equal(parent.packageCount, 0, "父单件数被改了（货没卸成，不该还回去）");
    });
    await check("F1 派送中的子单卸柜（整票、部分）→ 都挡住，提示先从派送单里删掉", async () => {
      for (const body of [{ itemId: itDeliv.id }, { itemId: itDeliv.id, pieceCount: 2 }]) {
        const r = await call("POST /staff/loading-manifests/remove-shipment", STAFF, body);
        assert.notEqual(r.status, 200, `派送中的货照样卸了：${JSON.stringify(body)}`);
        assert.match(r.message, /派送中/, `提示不对：${r.message}`);
      }
      const it = await pm.shipmentContainerItem.findUnique({ where: { id: itDeliv.id } });
      assert.equal(it?.loadedPieceCount, 4, "部分卸柜照样减了件数");
      assert.ok(await pm.adminLastmileOrder.findUnique({ where: { id: "zz_f29_lm2" } }), "派送单没了");
    });

    await check("F1 删柜子：柜里有已排派送的货 → 整个删柜挡住，柜子、柜内记录、派送单都还在（删柜走的是同一个卸柜函数）", async () => {
      const ctr = await pm.container.create({ data: { companyId: CO, containerNo: "ZZF29DEL1", containerType: "40HQ", currentStatus: "LOADING", transportMode: "sea" } });
      await mkOrder("zz_f29_o9");
      await mkShip("zz_f29_s9", "zz_f29_o9", "ZZF29S9", "loaded");
      const it = await pm.shipmentContainerItem.create({ data: { containerId: ctr.id, shipmentId: "zz_f29_s9", loadedPieceCount: 10, loadedVolumeM3: 1 } });
      // 正常页面走不到（派送候选只列泰国仓的货），但接口直接调能把装柜中的货排进派送单（9-29 测试员实测）
      await pm.adminLastmileOrder.create({ data: { id: "zz_f29_lm9", companyId: CO, deliveryNo: "ZZF29D9", shipmentId: "zz_f29_s9", carrierName: "车队", externalTrackingNo: "X", status: "DELIVERING" } });
      const r = await call("DELETE /admin/containers", ADMIN, {}, { id: ctr.id });
      assert.notEqual(r.status, 200, "柜里有已排派送的货，柜子照样删了");
      assert.match(r.message, /派送/, `提示不对：${r.message}`);
      assert.ok(await pm.container.findUnique({ where: { id: ctr.id } }), "柜子没了");
      assert.ok(await pm.shipmentContainerItem.findUnique({ where: { id: it.id } }), "柜内记录没了");
      assert.ok(await pm.adminLastmileOrder.findUnique({ where: { id: "zz_f29_lm9" } }), "派送单没了");
    });

    // ---------- F2 卸柜件数填超 ----------
    const ctrL = await pm.container.create({ data: { companyId: CO, containerNo: "ZZF29LD1", containerType: "40HQ", currentStatus: "LOADING", transportMode: "sea" } });
    await mkOrder("zz_f29_o2");
    await mkShip("zz_f29_s2", "zz_f29_o2", "ZZF29S2", "loaded", { packageCount: 5, volumeM3: 0.5, weightKg: 50 });
    const it2 = await pm.shipmentContainerItem.create({ data: { containerId: ctrL.id, shipmentId: "zz_f29_s2", loadedPieceCount: 5, loadedVolumeM3: 0.5 } });
    await check("F2 已装 5 件、卸柜填 99 → 400「超过」，柜内记录和运单都不动；填 5 → 照常整票卸", async () => {
      const r = await call("POST /staff/loading-manifests/remove-shipment", STAFF, { itemId: it2.id, pieceCount: 99 });
      assert.equal(r.status, 400, "填超了照样卸");
      assert.match(r.message, /超过/, `提示不对：${r.message}`);
      assert.equal((await pm.shipmentContainerItem.findUnique({ where: { id: it2.id } }))?.loadedPieceCount, 5, "柜内记录被动了");
      assert.equal((await pm.shipment.findUnique({ where: { id: "zz_f29_s2" } })).currentStatus, "loaded", "运单状态被动了");
      const ok5 = await call("POST /staff/loading-manifests/remove-shipment", STAFF, { itemId: it2.id, pieceCount: 5 });
      assert.equal(ok5.status, 200, ok5.message);
      assert.equal(await pm.shipmentContainerItem.findUnique({ where: { id: it2.id } }), null, "填等于已装件数没整票卸");
    });

    // ---------- F3 单号不回收 ----------
    await check("F3 发号函数：记录只往上走，比「现有最大号」小时也不倒回；并发发号不重号", async () => {
      const one = (max: number) => pm.$transaction((tx: any) => nextSequenceValue(tx, "zz_f29_seq", max));
      assert.equal(await one(5), 6, "表是空的：应接着现有最大号发");
      assert.equal(await one(5), 7, "最大号那张单被删了（最大号还是 5）：应发 7，不能再发 6");
      assert.equal(await one(100), 101, "有人插了更大的号：应接着它发");
      assert.equal(await one(3), 102, "最大号变小了也不能倒回");
      const many = await Promise.all(Array.from({ length: 6 }, () => one(0)));
      assert.equal(new Set(many).size, 6, `并发发出了重号：${many}`);
    });
    await check("F3 集货任务号：删掉最新那张，再建一张不会拿回同一个号", async () => {
      const a = await call("POST /client/consolidation/tasks", C1, { destinationTh: "曼谷" });
      assert.equal(a.status, 200, a.message);
      const ta = await pm.consolidationTask.findFirst({ where: { companyId: CO }, orderBy: { createdAt: "desc" } });
      const d = await call("POST /admin/consolidation/tasks/delete", ADMIN, { taskId: ta.id });
      assert.equal(d.status, 200, d.message);
      const b = await call("POST /client/consolidation/tasks", C1, { destinationTh: "曼谷" });
      assert.equal(b.status, 200, b.message);
      const tb = await pm.consolidationTask.findFirst({ where: { companyId: CO }, orderBy: { createdAt: "desc" } });
      assert.notEqual(tb.taskNo, ta.taskNo, `删掉 ${ta.taskNo} 后新任务又拿到了 ${tb.taskNo}`);
      assert.ok(Number(tb.taskNo.slice(2)) > Number(ta.taskNo.slice(2)), `新号 ${tb.taskNo} 不比 ${ta.taskNo} 大`);
      // F7 顺手：被删的任务客户再点开 → 404「已被删除」
      const gone = await call("GET /client/consolidation/tasks/detail", C1, {}, { taskId: ta.id });
      assert.equal(gone.status, 404, `被删的任务回 ${gone.status}：${gone.message}`);
      assert.match(gone.message, /删除/, gone.message);
      const other = await call("GET /client/consolidation/tasks/detail", C2, {}, { taskId: tb.id });
      assert.equal(other.status, 403, "别人的任务不该给看");
    });
    await check("F3 派送单号 WD：删掉最新那张，再建一张不会拿回同一个号", async () => {
      await mkOrder("zz_f29_o3");
      await mkShip("zz_f29_s3", "zz_f29_o3", "ZZF29S3", "inWarehouseTH");
      const mk = () => call("POST /admin/lastmile/orders", ADMIN, { shipmentIds: ["zz_f29_s3"], driverName: "zz_f29_司机", phoneNumber: "0800000000", deliveryDate: "2026-09-29" });
      const a = await mk();
      assert.equal(a.status, 200, a.message);
      const la = await pm.adminLastmileOrder.findFirst({ where: { companyId: CO, shipmentId: "zz_f29_s3" } });
      const del = await call("DELETE /admin/lastmile/orders", ADMIN, {}, { id: la.id });
      assert.equal(del.status, 200, del.message);
      const b = await mk();
      assert.equal(b.status, 200, b.message);
      const lb = await pm.adminLastmileOrder.findFirst({ where: { companyId: CO, shipmentId: "zz_f29_s3" } });
      assert.notEqual(lb.deliveryNo, la.deliveryNo, `删掉 ${la.deliveryNo} 后新派送单又拿到了 ${lb.deliveryNo}`);
    });

    // ---------- F4 / F5 / F6 仓库版集货 ----------
    const MASK_CTR = "ZZF29CTN9";
    await pm.container.create({ data: { companyId: CO, containerNo: MASK_CTR, containerType: "40HQ", currentStatus: "LOADING", transportMode: "sea" } });
    const plan = await call("POST /admin/whr-consolidation/plans", ADMIN, {
      destinationTh: "曼谷", totalVolumeM3: 68,
      customers: [C1, C2].map((c) => ({ clientId: c.userId, unitPriceNormal: 100, unitPriceInspection: 200, unitPriceSensitive: 300 })),
    });
    const planId: string = plan.data?.id;
    await check("F4 客户名下只剩已取消的预报单 → 能移除客户（原来取消完照样挡）", async () => {
      assert.equal(plan.status, 200, plan.message);
      assert.equal((await call("POST /client/whr-consolidation/address", C2, { planId, deliveryAddress: "曼谷二号" })).status, 200);
      const q = await call("POST /client/whr-consolidation/prealerts", C2, { planId, mark: "Q1" });
      assert.equal(q.status, 200, q.message);
      const cancel = await call("POST /admin/whr-consolidation/prealerts/cancel", ADMIN, { planId, prealertId: q.data?.id, cancelReason: "客户不发了" });
      assert.equal(cancel.status, 200, cancel.message);
      const cust = await pm.whrConsolidationPlanCustomer.findFirst({ where: { planId, clientId: C2.userId } });
      const rm = await call("POST /admin/whr-consolidation/customers/remove", ADMIN, { planId, customerId: cust.id });
      assert.equal(rm.status, 200, `只剩已取消的单还是移不掉：${rm.message}`);
      assert.equal(await pm.whrConsolidationPlanCustomer.findUnique({ where: { id: cust.id } }), null);
    });
    let p1 = ""; let p2 = "";
    await check("F5 柜子全签收变「装柜中」后客户再报一票 → 柜子回「集货中」", async () => {
      assert.equal((await call("POST /client/whr-consolidation/address", C1, { planId, deliveryAddress: "曼谷一号" })).status, 200);
      const a = await call("POST /client/whr-consolidation/prealerts", C1, { planId, mark: "P1" });
      assert.equal(a.status, 200, a.message);
      p1 = a.data?.id;
      const items = await call("POST /client/whr-consolidation/prealerts/items", C1, { prealertId: p1, items: [{ productName: "鞋", packageCount: 1, quantityPerBox: 10, lengthCm: 100, widthCm: 100, heightCm: 50, unitWeightKg: 5, material: "布", cargoValue: "1000", cargoType: "normal" }] });
      assert.equal(items.status, 200, items.message);
      const sign = await call("POST /staff/whr-consolidation/prealert-sign", STAFF, { planId, prealertId: p1, receiptProofs: [{ fileName: "a.png", mime: "image/png", base64: PNG }] });
      assert.equal(sign.status, 200, sign.message);
      assert.equal((await pm.whrConsolidationPlan.findUnique({ where: { id: planId } })).status, "loading", "（前提）全签收后柜子该是装柜中");
      const b = await call("POST /client/whr-consolidation/prealerts", C1, { planId, mark: "P2" });
      assert.equal(b.status, 200, b.message);
      p2 = b.data?.id;
      assert.equal((await pm.whrConsolidationPlan.findUnique({ where: { id: planId } })).status, "collecting", "客户又报了一票，柜子还停在装柜中");
    });
    await check("F6 员工写在取消原因里的柜号（标准样子的、本公司柜子表里的）客户看不到；时间线备注同样抹", async () => {
      const reason = `柜号 MSKU1234565 已满，改装 ${MASK_CTR} 那柜`;
      const c = await call("POST /admin/whr-consolidation/prealerts/cancel", ADMIN, { planId, prealertId: p2, cancelReason: reason });
      assert.equal(c.status, 200, c.message);
      const d = await call("GET /client/whr-consolidation/my-detail", C1, {}, { planId });
      assert.equal(d.status, 200, d.message);
      const text = JSON.stringify(d.data);
      assert.ok(!text.includes("MSKU1234565"), "标准样子的柜号客户看得到");
      assert.ok(!text.includes(MASK_CTR), "本公司柜子表里的柜号客户看得到");
      const pa = d.data.prealerts.find((x: Row) => x.id === p2);
      assert.ok(pa?.cancelReason && pa.cancelReason.includes("已满"), `取消原因整段没了（只该抹柜号）：${pa?.cancelReason}`);
    });

    // ---------- F8 上传大小 ----------
    await mkOrder("zz_f29_o4");
    await mkShip("zz_f29_s4", "zz_f29_o4", "ZZF29S4", "inWarehouseCN");
    await check("F8 入库照片：约 3MB 的照片能传；太大的给中文提示（原来 400 万字就挡、英文）", async () => {
      const ok3 = await call("POST /staff/inbound-photos", STAFF, { shipmentId: "zz_f29_s4", fileName: "a.jpg", mime: "image/jpeg", contentBase64: "A".repeat(4_200_000) });
      assert.equal(ok3.status, 200, `3MB 照片传不上：${ok3.message}`);
      const big = await call("POST /staff/inbound-photos", STAFF, { shipmentId: "zz_f29_s4", fileName: "b.jpg", mime: "image/jpeg", contentBase64: "A".repeat(9_600_000) });
      assert.equal(big.status, 400);
      assert.match(big.message, /图片太大/, `提示不是中文：${big.message}`);
    });
    await check("F8 运单产品图太大：中文提示（原来 file too large）", async () => {
      const big = await call("POST /staff/orders/product-images", STAFF, { orderId: "zz_f29_o4", fileName: "b.jpg", mime: "image/jpeg", contentBase64: "A".repeat(9_600_000) });
      assert.equal(big.status, 400);
      assert.match(big.message, /图片太大/, `提示不是中文：${big.message}`);
      assert.doesNotMatch(big.message, /too large/i);
    });
  } finally {
    await cleanup();
    const left = await pm.user.count({ where: { companyId: CO } }) + await pm.shipment.count({ where: { companyId: CO } }) + await pm.container.count({ where: { companyId: CO } });
    console.log(`清理后残留：${left}`);
    await prisma.$disconnect();
  }
  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
