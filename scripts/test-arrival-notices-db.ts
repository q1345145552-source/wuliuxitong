/**
 * 到货通知（2026-10-06）—— 连库回归（真 handler + 真 PostgreSQL）。
 *
 * 老板拍板（原话见 schema.prisma 里 ArrivalNotice 那段）：国内仓到货登记 → 客服复制文案 / 照片通知客户 →
 * 标「已通知客户」→ 员工自己选「转正式运单」还是「转待入库」，系统只查必填项；
 * 转正式要齐（同「创建订单」）、转待入库至少要唛头 + 运单号；客户在「运单查询」里看得到「待入库」；待入库不能装柜。
 *
 * 盯：
 *   N1~N5   登记、填错拦、运单号查重、已通知开关、页签数字
 *   N6~N11  转待入库（只要唛头 + 运单号）、客户看得到、待入库时改资料 / 传删照片同步到运单、运单管理两条改单路都挡、装柜挡
 *   N12~N14 待入库 → 正式（同一张运单、写轨迹、之后只读）、直接转正式跟「创建订单」写出来一个样
 *   N15~N19 删除、运单被删后能重转、公司隔离、客户 / 代理进不来、两人同时点转只建一张
 *
 * 只连测试库：DATABASE_URL 不带 neon.tech 的不跑（一次性 docker 库设 AGENT_PORTAL_TEST_ALLOW_DB=1）；
 * 没有 DATABASE_URL 打印「跳过」。测试数据全在假公司 zz_arrival_co / zz_arrival_co2 下，开跑前、跑完后都清干净。
 * 图片写进临时目录（IMAGES_DIR），跑完删掉。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Row = Record<string, any>;
type Auth = { userId: string; companyId: string; role: string; name: string; agentId: string | null };
const CO = "zz_arrival_co";
const CO2 = "zz_arrival_co2";
const ADMIN: Auth = { userId: "zz_arrival_admin", companyId: CO, role: "admin", name: "超管老王", agentId: null };
const STAFF: Auth = { userId: "zz_arrival_staff", companyId: CO, role: "staff", name: "员工小李", agentId: null };
const STAFF2: Auth = { userId: "zz_arrival_staff2", companyId: CO, role: "staff", name: "员工小张", agentId: null };
const CLIENT: Auth = { userId: "ZZARA01", companyId: CO, role: "client", name: "客户甲", agentId: null };
const CLIENT_B: Auth = { userId: "ZZARB02", companyId: CO, role: "client", name: "客户乙", agentId: null };
const OTHER_STAFF: Auth = { userId: "zz_arrival_o_staff", companyId: CO2, role: "staff", name: "别家员工", agentId: null };
const OTHER_CLIENT: Auth = { userId: "ZZARO03", companyId: CO2, role: "client", name: "别家客户", agentId: null };
const AGENT: Auth = { userId: "zz_arrival_agent_user", companyId: CO, role: "agent", name: "代理", agentId: "zz_arrival_agent" };
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const NO = (s: string) => `ZZAN${s}`;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (!url.includes("neon.tech") && process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：DATABASE_URL 不是 Neon 测试库，怕连到生产库不跑（确认是测试库可设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  const imagesDir = fs.mkdtempSync(path.join(os.tmpdir(), "zz-arrival-img-"));
  process.env.IMAGES_DIR = imagesDir;

  const { prisma } = await import("../apps/api/src/db/prisma");
  const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
  const pm: any = prisma;

  const routes = new Map<string, Function>();
  const app: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) app[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
  (await import("../apps/api/src/modules/arrival-notices/routes")).registerArrivalNoticeRoutes(app);
  (await import("../apps/api/src/modules/orders/routes")).registerOrderRoutes(app);
  (await import("../apps/api/src/modules/admin/routes")).registerAdminRoutes(app);
  (await import("../apps/api/src/modules/loading-manifests/routes")).registerLoadingManifestRoutes(app);
  (await import("../apps/api/src/modules/containers/routes")).registerContainerRoutes(app);
  (await import("../apps/api/src/modules/admin-ops/routes")).registerAdminOpsRoutes(app);
  (await import("../apps/api/src/modules/shipments/routes")).registerShipmentRoutes(app);

  async function call(key: string, auth: Auth, body: Row = {}, query: Record<string, string> = {}): Promise<{ status: number; data: any; message: string }> {
    const handler = routes.get(key);
    if (!handler) return { status: 404, data: undefined, message: `没有这个接口：${key}` };
    let status = 200; let raw: any;
    const res: any = { status(s: number) { status = s; return res; }, json(p: any) { raw = p; }, setHeader() {} };
    try { await handler({ method: key.split(" ")[0], body, query, headers: {}, auth, path: key.split(" ")[1] }, res); }
    catch (e) { if (e instanceof BusinessError) { status = e.httpStatus; raw = { code: e.code, message: e.message }; } else throw e; }
    return { status, data: raw?.data, message: raw?.message ?? "" };
  }
  async function must(key: string, auth: Auth, body: Row = {}, query: Record<string, string> = {}): Promise<any> {
    const r = await call(key, auth, body, query);
    assert.equal(r.status, 200, `${key} 应该成功，实际 ${r.status}：${r.message}`);
    return r.data;
  }
  async function refuse(key: string, auth: Auth, body: Row, pattern: RegExp, status = 400): Promise<void> {
    const r = await call(key, auth, body);
    assert.equal(r.status, status, `${key} 应该被挡（${status}），实际 ${r.status}：${r.message}`);
    assert.match(r.message, pattern);
  }
  const save = (auth: Auth, body: Row) => must("POST /staff/arrival-notices/save", auth, body).then((d) => d.item);
  const list = (auth: Auth, q: Record<string, string> = {}) => must("GET /staff/arrival-notices/list", auth, {}, q);

  async function cleanup(): Promise<void> {
    for (const co of [CO, CO2]) {
      const ns = await pm.arrivalNotice.findMany({ where: { companyId: co }, select: { id: true } });
      await pm.arrivalNoticeImage.deleteMany({ where: { noticeId: { in: ns.map((n: Row) => n.id) } } });
      await pm.arrivalNotice.deleteMany({ where: { companyId: co } });
      const cs = await pm.container.findMany({ where: { companyId: co }, select: { id: true } });
      await pm.shipmentContainerItem.deleteMany({ where: { containerId: { in: cs.map((c: Row) => c.id) } } });
      await pm.container.deleteMany({ where: { companyId: co } });
      await pm.adminLastmileOrder.deleteMany({ where: { companyId: co } });
      await pm.statusLog.deleteMany({ where: { companyId: co } });
      await pm.orderProductImage.deleteMany({ where: { companyId: co } });
      await pm.orderProduct.deleteMany({ where: { companyId: co } });
      await pm.shipment.deleteMany({ where: { companyId: co } });
      await pm.order.deleteMany({ where: { companyId: co } });
      await pm.auditLog.deleteMany({ where: { companyId: co } });
      await pm.user.deleteMany({ where: { companyId: co } });
    }
  }

  let passed = 0, failed = 0;
  async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`✅ ${name}`); }
    catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
  }
  const full = {
    clientId: CLIENT.userId, trackingNo: NO("F001"), itemName: "灯具", packageCount: 12, weightKg: 85.5, volumeM3: 0.625,
    transportMode: "sea", domesticTrackingNo: "SF1234567890", warehouseId: "wh_yiwu_01", arrivedAt: "2026-10-06", remark: "内部备注：外箱有破损",
  };

  await cleanup();
  try {
    for (const u of [ADMIN, STAFF, STAFF2, CLIENT, CLIENT_B, OTHER_STAFF, OTHER_CLIENT]) {
      await pm.user.create({ data: { id: u.userId, companyId: u.companyId, role: u.role, name: u.name, passwordHash: "x", phone: `0${u.userId}`, status: "active" } });
    }

    let blankId = "";
    await check("N1 什么都不填也能先存；列表「待通知」里有它；登记人名字只给超管看（员工拿到的是空）", async () => {
      const item = await save(STAFF, {});
      blankId = item.id;
      assert.equal(item.clientId, null);
      assert.equal(item.convertedTo, null);
      assert.equal(item.notifiedAt, null);
      assert.equal(item.createdByName, null, "员工不能看到是谁登记的（老板 2026-09-15：操作人只给超管）");
      const asAdmin = (await list(ADMIN)).items.find((x: Row) => x.id === blankId);
      assert.equal(asAdmin.createdByName, STAFF.name, "超管看得到登记人");
      assert.equal(await pm.arrivalNotice.count({ where: { id: blankId, createdByName: STAFF.name, createdBy: STAFF.userId } }), 1, "库里照样记着");
      const l = await list(STAFF, { tab: "todo" });
      assert.ok(l.items.some((x: Row) => x.id === blankId));
      assert.equal(l.counts.todo, 1);
      assert.equal(l.counts.all, 1);
    });

    await check("N2 填错的当场挡，一个字都不存（件数、重量、体积、仓库、运输方式、日期、唛头）", async () => {
      const bad: Array<[Row, RegExp]> = [
        [{ packageCount: 0 }, /件数必须是正整数/],
        [{ packageCount: 2.5 }, /件数必须是正整数/],
        [{ packageCount: true }, /件数必须是正整数/],
        [{ weightKg: 0.001 }, /重量不能小于 0.01/],
        [{ weightKg: -3 }, /重量不能小于/],
        [{ volumeM3: 1.2345 }, /体积最多只能有 3 位小数/],
        [{ warehouseId: "wh_bangkok" }, /仓库只能选/],
        [{ transportMode: "air" }, /运输方式只能选海运或陆运/],
        [{ arrivedAt: "2026-02-31" }, /不是有效日期/],
        [{ arrivedAt: "2026-10" }, /不是有效日期/],
        [{ clientId: "NOPE-0000" }, /唛头「NOPE-0000」不存在/],
        [{ clientId: OTHER_CLIENT.userId }, /不存在/],
        [{ clientId: STAFF2.userId }, /不存在/],
        [{ itemName: "x".repeat(201) }, /品名太长了/],
      ];
      for (const [body, re] of bad) await refuse("POST /staff/arrival-notices/save", STAFF, body, re);
      const n = await pm.arrivalNotice.count({ where: { companyId: CO } });
      assert.equal(n, 1, "填错的一条都不能存进去");
    });

    let fullId = "";
    await check("N3 运单号查重：跟已有运单重、跟别的到货通知重都挡；改自己那条不算重", async () => {
      const a = await save(STAFF, full);
      fullId = a.id;
      assert.equal(a.weightKg, 85.5);
      assert.equal(a.volumeM3, 0.625);
      assert.equal(a.remark, "内部备注：外箱有破损");
      await refuse("POST /staff/arrival-notices/save", STAFF, { trackingNo: NO("F001") }, /已经登记在另一条到货通知里了/);
      // 员工端「创建订单」建一张，拿它的号来登记
      await must("POST /staff/orders", STAFF, { clientId: CLIENT_B.userId, trackingNo: NO("EXIST1"), itemName: "老单", packageCount: 1, transportMode: "sea", warehouseId: "wh_yiwu_01", arrivedAt: "2026-10-01" });
      await refuse("POST /staff/arrival-notices/save", STAFF, { trackingNo: NO("EXIST1") }, /已经有运单了/);
      const again = await save(STAFF, { ...full, id: fullId, itemName: "LED 灯具" });
      assert.equal(again.itemName, "LED 灯具", "改自己那条、运单号没变，不能说重");
    });

    await check("N4 「已通知客户」开关：标上记时间和人（人名只给超管看），改回清空；页签数字跟着变", async () => {
      const on = (await must("POST /staff/arrival-notices/notify", STAFF2, { id: fullId, notified: true })).item;
      assert.ok(on.notifiedAt);
      assert.equal(on.notifiedByName, null, "员工拿不到是谁通知的");
      assert.equal((await list(ADMIN)).items.find((x: Row) => x.id === fullId).notifiedByName, STAFF2.name, "超管看得到");
      assert.equal(await pm.arrivalNotice.count({ where: { id: fullId, notifiedBy: STAFF2.userId, notifiedByName: STAFF2.name } }), 1, "库里记着是谁");
      let l = await list(STAFF);
      assert.equal(l.counts.todo, 1);
      assert.equal(l.counts.notified, 1);
      const off = (await must("POST /staff/arrival-notices/notify", STAFF, { id: fullId, notified: false })).item;
      assert.equal(off.notifiedAt, null);
      assert.equal(off.notifiedByName, null);
      l = await list(STAFF);
      assert.equal(l.counts.todo, 2);
      await must("POST /staff/arrival-notices/notify", STAFF2, { id: fullId, notified: true });
      await refuse("POST /staff/arrival-notices/notify", STAFF, { id: fullId, notified: "yes" }, /true 或 false/);
    });

    await check("N5 搜索：唛头 / 运单号 / 国内单号 / 品名都能搜到，搜不到的不出来", async () => {
      for (const kw of [CLIENT.userId.toLowerCase(), "F001", "SF12345", "LED"]) {
        const l = await list(STAFF, { keyword: kw });
        assert.deepEqual(l.items.map((x: Row) => x.id), [fullId], `搜「${kw}」`);
      }
      assert.equal((await list(STAFF, { keyword: "不存在的东西" })).total, 0);
    });

    await check("N6 转运单缺项：点名缺什么，什么都不建（转正式要齐；转待入库要唛头 + 运单号）", async () => {
      await refuse("POST /staff/arrival-notices/convert", STAFF, { id: blankId, to: "formal" }, /转正式运单还缺：运单号、唛头、品名、仓库、运输方式、到仓日期、件数、重量、体积/);
      await refuse("POST /staff/arrival-notices/convert", STAFF, { id: blankId, to: "inbound" }, /转待入库还缺：运单号、唛头。/);
      await save(STAFF, { id: blankId, trackingNo: NO("P001") });
      await refuse("POST /staff/arrival-notices/convert", STAFF, { id: blankId, to: "inbound" }, /转待入库还缺：唛头。/);
      await refuse("POST /staff/arrival-notices/convert", STAFF, { id: blankId, to: "whatever" }, /要选「转正式运单」还是「转待入库」/);
      assert.equal(await pm.shipment.count({ where: { companyId: CO, trackingNo: NO("P001") } }), 0);
    });

    let pendingShipId = "", pendingOrderId = "";
    await check("N7 转待入库：建出「待入库」运单 + 第一条轨迹；有品名才建产品行；照片复制成产品图片（另一份文件）", async () => {
      const withPhoto = (await must("POST /staff/arrival-notices/images", STAFF, { noticeId: blankId, fileName: "到货.png", mime: "image/png", contentBase64: PNG_1x1 })).item;
      assert.equal(withPhoto.images.length, 1);
      await save(STAFF, { id: blankId, trackingNo: NO("P001"), clientId: CLIENT.userId, packageCount: 3 });
      const item = (await must("POST /staff/arrival-notices/convert", STAFF, { id: blankId, to: "inbound" })).item;
      assert.equal(item.convertedTo, "inbound");
      assert.equal(item.shipmentStatus, "pendingInbound");
      const ship = await pm.shipment.findFirst({ where: { trackingNo: NO("P001") }, include: { order: true, statusLogs: true } });
      assert.ok(ship);
      pendingShipId = ship.id; pendingOrderId = ship.orderId;
      assert.equal(item.shipmentId, ship.id);
      assert.equal(ship.currentStatus, "pendingInbound");
      assert.equal(ship.order.clientId, CLIENT.userId);
      assert.equal(ship.order.approvalStatus, "approved");
      assert.equal(ship.packageCount, 3);
      assert.equal(ship.order.transportMode, "", "还没选运输方式：订单上先存空串");
      assert.equal(ship.statusLogs.length, 1);
      assert.equal(ship.statusLogs[0].fromStatus, "created");
      assert.equal(ship.statusLogs[0].toStatus, "pendingInbound");
      assert.equal(ship.statusLogs[0].remark, "货已到国内仓，资料待补全");
      assert.equal(ship.statusLogs[0].operatorName, STAFF.name);
      assert.equal(await pm.orderProduct.count({ where: { orderId: ship.orderId } }), 0, "没品名不建产品行");
      const imgs = await pm.orderProductImage.findMany({ where: { orderId: ship.orderId } });
      assert.equal(imgs.length, 1);
      assert.notEqual(imgs[0].filePath, withPhoto.images[0].imageUrl, "要复制一份文件，不能跟到货通知共用");
      const a = fs.readFileSync(path.join(imagesDir, path.basename(imgs[0].filePath)));
      const b = fs.readFileSync(path.join(imagesDir, path.basename(withPhoto.images[0].imageUrl)));
      assert.ok(a.equals(b), "复制出来的照片内容要一样");
      await refuse("POST /staff/arrival-notices/convert", STAFF, { id: blankId, to: "inbound" }, /已经是待入库了/);
    });

    await check("N8 客户「运单查询」看得到这张，状态是待入库；客户分组算「未发出」；别的客户看不到", async () => {
      const r = await must("GET /client/orders", CLIENT, {}, { trackingNo: NO("P001") });
      const hit = r.items.find((x: Row) => x.trackingNo === NO("P001"));
      assert.ok(hit, "客户要看得到待入库的单（老板选 3B）");
      assert.equal(hit.currentStatus, "pendingInbound");
      const pending = await must("GET /client/orders", CLIENT, {}, { statusGroup: "pending" });
      assert.ok(pending.items.some((x: Row) => x.trackingNo === NO("P001")), "待入库要算在「未发出」里");
      const transit = await must("GET /client/orders", CLIENT, {}, { statusGroup: "transit" });
      assert.ok(!transit.items.some((x: Row) => x.trackingNo === NO("P001")), "待入库不能掉进「在途」");
      const other = await must("GET /client/orders", CLIENT_B, {}, { trackingNo: NO("P001") });
      assert.ok(!other.items.some((x: Row) => x.trackingNo === NO("P001")));
    });

    await check("N9 待入库时在到货通知里改资料：同一个事务里同步到运单 / 订单 / 产品行；运单号、唛头不许清空", async () => {
      await save(STAFF, { id: blankId, trackingNo: NO("P001B"), clientId: CLIENT.userId, packageCount: 5, itemName: "玩具", weightKg: 40, transportMode: "land", warehouseId: "wh_guangzhou_01" });
      const ship = await pm.shipment.findUnique({ where: { id: pendingShipId }, include: { order: { include: { products: true } } } });
      assert.equal(ship.trackingNo, NO("P001B"), "运单号跟着改");
      assert.equal(ship.packageCount, 5);
      assert.equal(Number(ship.weightKg), 40);
      assert.equal(ship.transportMode, "land");
      assert.equal(ship.warehouseId, "wh_guangzhou_01");
      assert.equal(ship.order.itemName, "玩具");
      assert.equal(ship.order.transportMode, "land");
      assert.equal(ship.order.products.length, 1);
      assert.equal(ship.order.products[0].itemName, "玩具");
      assert.equal(ship.order.products[0].packageCount, 5);
      assert.equal(ship.order.products[0].domesticTrackingNo, "货拉拉", "国内单号空着跟「创建订单」一样写货拉拉");
      await refuse("POST /staff/arrival-notices/save", STAFF, { id: blankId, clientId: CLIENT.userId }, /运单号不能空着/);
      await refuse("POST /staff/arrival-notices/save", STAFF, { id: blankId, trackingNo: NO("P001B") }, /唛头不能空着/);
      await refuse("POST /staff/arrival-notices/save", STAFF, { id: blankId, trackingNo: NO("EXIST1"), clientId: CLIENT.userId }, /已经有运单了/);
      const after = await pm.shipment.findUnique({ where: { id: pendingShipId } });
      assert.equal(after.trackingNo, NO("P001B"), "被挡的那几次一个字都不能改到运单上");
    });

    await check("N10 运单管理两条改单路都不许改待入库的单（底稿在到货通知）", async () => {
      await refuse("POST /admin/orders/update", ADMIN, { orderId: pendingOrderId, itemName: "偷改", trackingNo: NO("P001B") }, /还是「待入库」.*到货通知/);
      await refuse("POST /staff/orders/patch-shipment-bundle", STAFF, { shipmentId: pendingShipId, trackingNo: NO("P001B"), itemName: "偷改", productQuantity: 1, packageCount: 1, orderCreatedDate: "2026-10-06", transportMode: "sea", receiverAddressTh: "" }, /还是「待入库」.*到货通知/);
      const o = await pm.order.findUnique({ where: { id: pendingOrderId } });
      assert.equal(o.itemName, "玩具");
    });

    await check("N11 待入库不能装柜：装柜接口挡；柜子推进的流程表里也没有它", async () => {
      const c = await must("POST /staff/loading-manifests", STAFF, { warehouse: "wh_guangzhou_01", transportMode: "land", containerNo: "ZZAN-CTN-01" });
      const cid = c.manifest?.id;
      assert.ok(cid, `建柜子没拿到 id：${JSON.stringify(c)}`);
      const r = await call("POST /staff/loading-manifests/add-shipment", STAFF, { trackingNo: NO("P001B") }, { id: cid });
      assert.equal(r.status, 400);
      assert.match(r.message, /待入库.*到货通知/);
      assert.equal(await pm.shipmentContainerItem.count({ where: { shipmentId: pendingShipId } }), 0);
      const { canTransitLoose } = await import("../apps/api/src/modules/shipments/routes");
      assert.equal(canTransitLoose("pendingInbound", "loaded"), false);
      assert.equal(canTransitLoose("pendingInbound", "inWarehouseCN"), false, "柜子推进那条路不能把它推成已入库");
    });

    await check("N12 待入库时传照片 / 删照片：运单产品图片跟着加 / 删，文件也删", async () => {
      const it = (await must("POST /staff/arrival-notices/images", STAFF, { noticeId: blankId, fileName: "侧面.png", mime: "image/png", contentBase64: PNG_1x1 })).item;
      assert.equal(it.images.length, 2);
      let imgs = await pm.orderProductImage.findMany({ where: { orderId: pendingOrderId } });
      assert.equal(imgs.length, 2, "新传的那张也要进运单");
      const second = await pm.arrivalNoticeImage.findUnique({ where: { id: it.images[1].id } });
      const copy = imgs.find((x: Row) => x.id === second.orderImageId);
      assert.ok(copy);
      await must("POST /staff/arrival-notices/images/delete", STAFF, { id: second.id });
      imgs = await pm.orderProductImage.findMany({ where: { orderId: pendingOrderId } });
      assert.equal(imgs.length, 1);
      assert.ok(!fs.existsSync(path.join(imagesDir, path.basename(second.filePath))), "到货照片文件要删");
      assert.ok(!fs.existsSync(path.join(imagesDir, path.basename(copy.filePath))), "运单那份副本文件也要删");
    });

    await check("N12b 待入库的单另外几个口子也改不了：确认收货、运单详情传 / 删产品图、建派送单、老的设柜号", async () => {
      await refuse("POST /staff/prealerts/receive", STAFF, { orderId: pendingOrderId, packageCount: 5, weightKg: 40, volumeM3: 0.3, itemName: "偷改" }, /还是「待入库」.*到货通知/);
      await refuse("POST /staff/orders/product-images", STAFF, { orderId: pendingOrderId, fileName: "x.png", mime: "image/png", contentBase64: PNG_1x1 }, /还是「待入库」.*到货通知/);
      await refuse("POST /staff/orders/product-images", CLIENT, { orderId: pendingOrderId, fileName: "x.png", mime: "image/png", contentBase64: PNG_1x1 }, /还是「待入库」.*到货通知/);
      const copy = await pm.orderProductImage.findFirst({ where: { orderId: pendingOrderId } });
      assert.ok(copy, "前面 N7 复制过来的那张还在");
      const del = await call("DELETE /staff/orders/product-images", STAFF, {}, { id: copy.id });
      assert.equal(del.status, 400, del.message);
      assert.match(del.message, /还是「待入库」/);
      const lm = await call("POST /admin/lastmile/orders", ADMIN, { shipmentIds: [pendingShipId], driverName: "司机", deliveryDate: "2026-10-06" });
      assert.ok(lm.status >= 400 && lm.status < 500, `建派送单应被挡，实际 ${lm.status}：${lm.message}`);
      assert.match(lm.message, /待入库/);
      await refuse("POST /staff/shipments/set-container", STAFF, { shipmentId: pendingShipId, containerNo: "ZZ-CTN" }, /还是「待入库」/);
      const after = await pm.shipment.findUnique({ where: { id: pendingShipId }, include: { order: true } });
      assert.equal(after.currentStatus, "pendingInbound");
      assert.equal(after.order.approvalStatus, "approved", "确认收货那条路一个字都没改到");
      assert.equal(after.containerNo, null);
      assert.equal(await pm.adminLastmileOrder.count({ where: { shipmentId: pendingShipId } }), 0);
      assert.equal(await pm.orderProductImage.count({ where: { orderId: pendingOrderId } }), 1);
    });

    await check("N13 待入库 → 正式：缺项挡；补齐后同一张运单变「已入库」、写一条轨迹；之后到货通知只读（已通知开关除外）", async () => {
      await refuse("POST /staff/arrival-notices/convert", STAFF, { id: blankId, to: "formal" }, /转正式运单还缺：到仓日期、体积/);
      await save(STAFF, { id: blankId, trackingNo: NO("P001B"), clientId: CLIENT.userId, packageCount: 5, itemName: "玩具", weightKg: 40, volumeM3: 0.3, transportMode: "land", warehouseId: "wh_guangzhou_01", arrivedAt: "2026-10-05", domesticTrackingNo: "YT998877" });
      const item = (await must("POST /staff/arrival-notices/convert", STAFF2, { id: blankId, to: "formal" })).item;
      assert.equal(item.convertedTo, "formal");
      assert.equal(item.shipmentId, pendingShipId, "还是同一张运单，不另建");
      assert.equal(item.shipmentStatus, "inWarehouseCN");
      const ship = await pm.shipment.findUnique({ where: { id: pendingShipId }, include: { statusLogs: { orderBy: { changedAt: "asc" } }, order: { include: { products: true } } } });
      assert.equal(ship.currentStatus, "inWarehouseCN");
      assert.equal(ship.statusLogs.length, 2);
      assert.equal(ship.statusLogs[1].fromStatus, "pendingInbound");
      assert.equal(ship.statusLogs[1].toStatus, "inWarehouseCN");
      assert.equal(ship.statusLogs[1].remark, "货已到国内仓，等待装柜");
      assert.equal(ship.statusLogs[1].operatorName, STAFF2.name);
      assert.equal(ship.order.shipDate, "2026-10-05");
      assert.equal(Number(ship.volumeM3), 0.3);
      assert.equal(ship.order.products[0].domesticTrackingNo, "YT998877");
      assert.equal(await pm.shipment.count({ where: { companyId: CO, orderId: ship.orderId } }), 1);
      await refuse("POST /staff/arrival-notices/save", STAFF, { id: blankId, ...full, trackingNo: NO("P001B") }, /已经转成正式运单了.*运单管理/);
      await refuse("POST /staff/arrival-notices/images", STAFF, { noticeId: blankId, fileName: "x.png", mime: "image/png", contentBase64: PNG_1x1 }, /已经转成正式运单了/);
      await refuse("POST /staff/arrival-notices/convert", STAFF, { id: blankId, to: "formal" }, /已经转成正式运单了/);
      await refuse("POST /staff/arrival-notices/delete", STAFF, { id: blankId }, /已经转成运单了，不能删/);
      await must("POST /staff/arrival-notices/notify", STAFF, { id: blankId, notified: true });
      // 变成已入库之后，运单管理那两条路恢复正常
      const upd = await call("POST /admin/orders/update", ADMIN, { orderId: pendingOrderId, itemName: "玩具（改）", trackingNo: NO("P001B") });
      assert.equal(upd.status, 200, upd.message);
    });

    await check("N14 直接转正式：写出来的订单 / 运单 / 轨迹 / 产品行跟员工端「创建订单」一模一样", async () => {
      const item = (await must("POST /staff/arrival-notices/convert", STAFF, { id: fullId, to: "formal" })).item;
      assert.equal(item.convertedTo, "formal");
      await must("POST /staff/orders", STAFF, {
        clientId: full.clientId, trackingNo: NO("TWIN"), itemName: "LED 灯具", packageCount: full.packageCount, weightKg: full.weightKg, volumeM3: full.volumeM3,
        transportMode: full.transportMode, domesticTrackingNo: full.domesticTrackingNo, warehouseId: full.warehouseId, arrivedAt: full.arrivedAt,
      });
      const load = (no: string) => pm.shipment.findFirst({ where: { trackingNo: no }, include: { statusLogs: true, order: { include: { products: true } } } });
      const a = await load(NO("F001"));
      const b = await load(NO("TWIN"));
      const pick = (o: Row, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k] instanceof Object && "toFixed" in o[k] ? String(o[k]) : o[k]]));
      const orderKeys = ["clientId", "warehouseId", "batchNo", "orderNo", "approvalStatus", "itemName", "productQuantity", "packageCount", "packageUnit", "weightKg", "volumeM3", "receivableCurrency", "shipDate", "domesticTrackingNo", "transportMode", "cargoType", "receiverNameTh", "receiverPhoneTh", "receiverAddressTh", "statusGroup", "paymentStatus"];
      assert.deepEqual(pick(a.order, orderKeys), pick(b.order, orderKeys), "订单");
      const shipKeys = ["batchNo", "currentStatus", "currentLocation", "weightKg", "volumeM3", "packageCount", "packageUnit", "transportMode", "domesticTrackingNo", "warehouseId", "remark", "parentTrackingNo"];
      assert.deepEqual(pick(a, shipKeys), pick(b, shipKeys), "运单");
      const logKeys = ["fromStatus", "toStatus", "remark", "nextStop", "operatorRole", "operatorName"];
      assert.deepEqual(pick(a.statusLogs[0], logKeys), pick(b.statusLogs[0], logKeys), "轨迹");
      const prodKeys = ["itemName", "packageCount", "lengthCm", "widthCm", "heightCm", "productQuantity", "cargoType", "domesticTrackingNo", "weightKg", "sortOrder"];
      assert.equal(a.order.products.length, 1);
      assert.deepEqual(pick(a.order.products[0], prodKeys), pick(b.order.products[0], prodKeys), "产品行");
      assert.equal(a.remark, null, "到货通知的内部备注不进运单");
    });

    await check("N15 删除：没转的能删（照片文件一起删）；转了的不让删", async () => {
      const n = await save(STAFF, { itemName: "要删的" });
      const withImg = (await must("POST /staff/arrival-notices/images", STAFF, { noticeId: n.id, fileName: "a.png", mime: "image/png", contentBase64: PNG_1x1 })).item;
      const file = path.join(imagesDir, path.basename(withImg.images[0].imageUrl));
      assert.ok(fs.existsSync(file));
      await must("POST /staff/arrival-notices/delete", STAFF, { id: n.id });
      assert.equal(await pm.arrivalNotice.count({ where: { id: n.id } }), 0);
      assert.equal(await pm.arrivalNoticeImage.count({ where: { noticeId: n.id } }), 0);
      assert.ok(!fs.existsSync(file), "照片文件也要删");
      await refuse("POST /staff/arrival-notices/delete", STAFF, { id: fullId }, /已经转成运单了，不能删/);
    });

    await check("N16 转出去的运单在运单管理里被删：到货通知回到「没转」、提示一句，可以重新转（照片重新复制）", async () => {
      const n = await save(STAFF, { clientId: CLIENT_B.userId, trackingNo: NO("G001") });
      await must("POST /staff/arrival-notices/images", STAFF, { noticeId: n.id, fileName: "g.png", mime: "image/png", contentBase64: PNG_1x1 });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "inbound" });
      const ship = await pm.shipment.findFirst({ where: { trackingNo: NO("G001") } });
      await must("POST /admin/orders/delete", ADMIN, { orderId: ship.orderId });
      const l = await list(STAFF, { keyword: NO("G001") });
      const row = l.items[0];
      assert.equal(row.shipmentGone, true);
      assert.equal(row.convertedTo, null);
      assert.equal(row.shipmentId, null);
      // 页签跟行上的说法一致：回到「待通知」（没点过已通知），不再算在「待入库」里
      assert.equal(l.counts.todo, 1, "运单被删了，这条要回到「待通知」页签");
      assert.equal(l.counts.inbound, 0, "运单被删了，「待入库」页签不能还数着它");
      assert.ok((await list(STAFF, { keyword: NO("G001"), tab: "todo" })).items.some((x: Row) => x.id === n.id));
      const again = (await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "inbound" })).item;
      assert.equal(again.convertedTo, "inbound");
      assert.equal(again.shipmentGone, false);
      const ship2 = await pm.shipment.findFirst({ where: { trackingNo: NO("G001") } });
      assert.notEqual(ship2.id, ship.id);
      assert.equal(await pm.orderProductImage.count({ where: { orderId: ship2.orderId } }), 1, "照片要重新复制到新运单");
    });

    await check("N17 公司隔离：别家员工看不到、改不了、转不了、删不了", async () => {
      const l = await list(OTHER_STAFF);
      assert.equal(l.total, 0);
      const otherBlank = await save(OTHER_STAFF, {});
      assert.ok(otherBlank.id);
      for (const [key, body] of [
        ["POST /staff/arrival-notices/save", { id: fullId, itemName: "x" }],
        ["POST /staff/arrival-notices/notify", { id: fullId, notified: false }],
        ["POST /staff/arrival-notices/convert", { id: blankId, to: "formal" }],
        ["POST /staff/arrival-notices/delete", { id: blankId }],
        ["POST /staff/arrival-notices/images", { noticeId: blankId, fileName: "x.png", mime: "image/png", contentBase64: PNG_1x1 }],
      ] as Array<[string, Row]>) {
        const r = await call(key, OTHER_STAFF, body);
        assert.equal(r.status, 404, `${key} 别家公司应 404，实际 ${r.status}：${r.message}`);
      }
      const img = await pm.arrivalNoticeImage.findFirst({ where: { companyId: CO } });
      const r = await call("POST /staff/arrival-notices/images/delete", OTHER_STAFF, { id: img.id });
      assert.equal(r.status, 404);
      await refuse("POST /staff/arrival-notices/save", OTHER_STAFF, { clientId: CLIENT.userId }, /不存在/);
    });

    await check("N18 客户、代理账号进不来（全部 403）", async () => {
      for (const who of [CLIENT, AGENT]) {
        for (const key of ["GET /staff/arrival-notices/list", "POST /staff/arrival-notices/save", "POST /staff/arrival-notices/notify", "POST /staff/arrival-notices/convert", "POST /staff/arrival-notices/delete", "POST /staff/arrival-notices/images", "POST /staff/arrival-notices/images/delete"]) {
          const r = await call(key, who, {});
          assert.equal(r.status, 403, `${who.role} 调 ${key} 应 403，实际 ${r.status}`);
        }
      }
    });

    await check("N19b 转运单时照片文件丢了：整个转运单不做，说清楚是哪张（不许悄悄少一张图转过去）", async () => {
      const n = await save(STAFF, { ...full, trackingNo: NO("LOST1"), itemName: "丢图" });
      const withImg = (await must("POST /staff/arrival-notices/images", STAFF, { noticeId: n.id, fileName: "侧面照.png", mime: "image/png", contentBase64: PNG_1x1 })).item;
      fs.rmSync(path.join(imagesDir, path.basename(withImg.images[0].imageUrl)));
      await refuse("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal" }, /照片「侧面照\.png」的文件找不到了/);
      assert.equal(await pm.shipment.count({ where: { trackingNo: NO("LOST1") } }), 0, "转运单要整个回滚");
      assert.equal((await pm.arrivalNotice.findUnique({ where: { id: n.id } })).convertedTo, null);
    });

    await check("N19c 两个人同时登记同一个运单号：只进得去一条，另一个被告知（数据库唯一约束兜底，不出 500）", async () => {
      const [a, b] = await Promise.all([
        call("POST /staff/arrival-notices/save", STAFF, { trackingNo: NO("DUP1") }),
        call("POST /staff/arrival-notices/save", STAFF2, { trackingNo: NO("DUP1") }),
      ]);
      const oks = [a, b].filter((r) => r.status === 200);
      assert.equal(oks.length, 1, `应该只有一条成功：${a.status} ${a.message} / ${b.status} ${b.message}`);
      assert.match([a, b].find((r) => r.status !== 200)!.message, /另一条到货通知/);
      assert.equal(await pm.arrivalNotice.count({ where: { companyId: CO, trackingNo: NO("DUP1") } }), 1);
    });

    await check("N19d 「转正式」和超管「删订单」同时点同一张待入库的单：不死锁、不出 500（锁序跟删订单一样先订单后运单）", async () => {
      for (let i = 0; i < 4; i++) {
        const n = await save(STAFF, { ...full, trackingNo: NO(`DL${i}`), itemName: `并发${i}` });
        await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "inbound" });
        const ship = await pm.shipment.findFirst({ where: { trackingNo: NO(`DL${i}`) } });
        const [c, d] = await Promise.all([
          call("POST /staff/arrival-notices/convert", STAFF2, { id: n.id, to: "formal" }),
          call("POST /admin/orders/delete", ADMIN, { orderId: ship.orderId }),
        ]);
        for (const r of [c, d]) assert.ok(r.status < 500, `第 ${i} 轮出了 ${r.status}：${r.message}`);
        const row = (await list(STAFF, { keyword: NO(`DL${i}`) })).items[0];
        const alive = await pm.shipment.findFirst({ where: { trackingNo: NO(`DL${i}`) } });
        // 两种先后都对：删在前 → 转正式重建了一张正式运单；转在前 → 正式运单又被删了，这条回到「没转」
        if (alive) {
          assert.equal(alive.currentStatus, "inWarehouseCN");
          assert.equal(row.convertedTo, "formal");
        } else {
          assert.equal(row.shipmentGone, true);
          assert.equal(row.convertedTo, null);
        }
      }
    });

    await check("N19 两个员工同时点「转正式」：只建出一张运单，另一个被告知已经转过", async () => {
      const n = await save(STAFF, { ...full, trackingNo: NO("RACE1"), itemName: "并发" });
      const [r1, r2] = await Promise.all([
        call("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal" }),
        call("POST /staff/arrival-notices/convert", STAFF2, { id: n.id, to: "formal" }),
      ]);
      const oks = [r1, r2].filter((r) => r.status === 200);
      assert.equal(oks.length, 1, `应该只有一个成功：${r1.status} ${r1.message} / ${r2.status} ${r2.message}`);
      const loser = [r1, r2].find((r) => r.status !== 200)!;
      assert.match(loser.message, /已经转成正式运单了/);
      assert.equal(await pm.shipment.count({ where: { trackingNo: NO("RACE1") } }), 1);
      const [s1, s2] = await Promise.all([
        call("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "inbound" }),
        call("POST /staff/arrival-notices/delete", STAFF2, { id: n.id }),
      ]);
      assert.ok(s1.status !== 200 && s2.status !== 200, "转完以后再转 / 删都不行");
    });
  } finally {
    await cleanup();
    fs.rmSync(imagesDir, { recursive: true, force: true });
    await prisma.$disconnect();
  }
  console.log(`\n${passed} 项通过，${failed} 项失败`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
