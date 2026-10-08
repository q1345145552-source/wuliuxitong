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
 *   N20~N29 2026-10-08 第四轮审查：撞预报单提醒 + 转单确认、待通知页签、没填件数 / 品名、改号跟随、
 *           「待入库」轨迹能恢复、改唛头清已通知、今日收货体积、货型、照片小图
 *   N30~N33 修复第 2 轮：确认收货改箱数同步唯一产品行、撞预报单粗筛被截断时逐条查、运单管理改唛头到货通知跟着改、
 *           照片格式白名单
 *   N34~N35 修复第 3 轮：改号和登记同一瞬间用同一个号只能成一边；跟号写的是运单当时的号、不写回读到的旧号
 *   N36     修复第 4 轮：跨公司（运单号全库唯一）改号也不许撞别家没转的到货通知，号锁不分公司排队
 *   N37~N49 2026-10-09 多款产品：两款存取 / 镜像列、每款校验报「第N款」、没品名能存转正式点名、待入库要么全建要么全不建、
 *           两款转正式跟「创建订单」一样、产品行算重量体积、冲突检测「产品明细变了」、老页面兼容（1 款能存 / 2 款挡）、
 *           平铺镜像不校验、第二款撞预报单、按第二款搜、部署窗口兜底、单箱数量全填或全空
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
  const { registerArrivalNoticeRoutes, translateUniqueClash } = await import("../apps/api/src/modules/arrival-notices/routes");
  registerArrivalNoticeRoutes(app);
  (await import("../apps/api/src/modules/agent-portal/routes")).registerAgentPortalRoutes(app);
  (await import("../apps/api/src/modules/orders/routes")).registerOrderRoutes(app);
  (await import("../apps/api/src/modules/admin/routes")).registerAdminRoutes(app);
  (await import("../apps/api/src/modules/loading-manifests/routes")).registerLoadingManifestRoutes(app);
  (await import("../apps/api/src/modules/containers/routes")).registerContainerRoutes(app);
  (await import("../apps/api/src/modules/admin-ops/routes")).registerAdminOpsRoutes(app);
  (await import("../apps/api/src/modules/shipments/routes")).registerShipmentRoutes(app);
  (await import("../apps/api/src/modules/cs-chat/routes")).registerCsChatRoutes(app); // N23 客服「选运单」

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
      await pm.agent.deleteMany({ where: { companyId: co } });
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

    await check("N19f 待入库 → 转正式：已复制到运单上的照片要核实还在；运单那份丢了从到货照片补，两份都丢了整个不转", async () => {
      const file = (url: string) => path.join(imagesDir, path.basename(url));
      const opiOf = async (orderId: string) => pm.orderProductImage.findMany({ where: { orderId }, select: { id: true, filePath: true } });
      const prep = async (no: string) => {
        const n = await save(STAFF, { ...full, trackingNo: NO(no), itemName: `补图${no}` });
        const withImg = (await must("POST /staff/arrival-notices/images", STAFF, { noticeId: n.id, fileName: `${no}.png`, mime: "image/png", contentBase64: PNG_1x1 })).item;
        await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "inbound" });
        const ship = await pm.shipment.findFirst({ where: { trackingNo: NO(no) } });
        const opis = await opiOf(ship.orderId);
        assert.equal(opis.length, 1, "转待入库时照片已经复制到运单上");
        return { n, ship, src: file(withImg.images[0].imageUrl), copy: file(opis[0].filePath) };
      };

      // ① 运单那份文件丢了、到货照片还在：转正式成功，运单上重新有一张能打开的图（坏记录删掉、不留裂图）
      const a = await prep("IMG1");
      fs.rmSync(a.copy);
      await must("POST /staff/arrival-notices/convert", STAFF, { id: a.n.id, to: "formal" });
      let opis = await opiOf(a.ship.orderId);
      assert.equal(opis.length, 1, "坏的那条删掉、补一条新的，运单上还是一张");
      assert.ok(fs.existsSync(file(opis[0].filePath)), "补上的那张文件在");
      assert.equal((await pm.shipment.findUnique({ where: { id: a.ship.id } })).currentStatus, "inWarehouseCN");

      // ② 运单那份和到货照片都丢了：整个不转，点名是哪张；运单还是待入库，坏记录也没被删（整个回滚）
      const b = await prep("IMG2");
      fs.rmSync(b.copy);
      fs.rmSync(b.src);
      await refuse("POST /staff/arrival-notices/convert", STAFF, { id: b.n.id, to: "formal" }, /照片「IMG2\.png」的文件找不到了/);
      assert.equal((await pm.shipment.findUnique({ where: { id: b.ship.id } })).currentStatus, "pendingInbound");
      assert.equal((await opiOf(b.ship.orderId)).length, 1, "回滚了，原来那条记录还在");

      // ②b 运单那份变成 0 字节的坏文件（文件在、但是空的）：也算丢了，从到货照片补（dsh 第三轮 C：原来只看「在不在」）
      const z = await prep("IMG0");
      fs.writeFileSync(z.copy, Buffer.alloc(0));
      await must("POST /staff/arrival-notices/convert", STAFF, { id: z.n.id, to: "formal" });
      const zo = await opiOf(z.ship.orderId);
      assert.equal(zo.length, 1);
      assert.ok(fs.statSync(file(zo[0].filePath)).size > 0, "补上的那张不是空文件");

      // ②c 两张照片：第一张运单那份丢了（会先补出一个新文件），第二张两份都丢了 → 整个回滚，
      //     先补出来的那个新文件也要删掉、不留孤儿（Codex 第三轮建议 3：单张的场景照不到这条清理路）
      const d = await save(STAFF, { ...full, trackingNo: NO("IMG4"), itemName: "两张" });
      await must("POST /staff/arrival-notices/images", STAFF, { noticeId: d.id, fileName: "IMG4a.png", mime: "image/png", contentBase64: PNG_1x1 });
      await must("POST /staff/arrival-notices/images", STAFF, { noticeId: d.id, fileName: "IMG4b.png", mime: "image/png", contentBase64: PNG_1x1 });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: d.id, to: "inbound" });
      const dShip = await pm.shipment.findFirst({ where: { trackingNo: NO("IMG4") } });
      const nImgs = await pm.arrivalNoticeImage.findMany({ where: { noticeId: d.id }, orderBy: { createdAt: "asc" } });
      assert.deepEqual(nImgs.map((i: Row) => i.fileName), ["IMG4a.png", "IMG4b.png"]);
      const copyOf = async (opiId: string) => file((await pm.orderProductImage.findUnique({ where: { id: opiId } })).filePath);
      fs.rmSync(await copyOf(nImgs[0].orderImageId));          // 第一张：运单那份丢了、到货照片还在 → 会先补一个新文件
      fs.rmSync(await copyOf(nImgs[1].orderImageId));          // 第二张：两份都丢了 → 抛错
      fs.rmSync(file(nImgs[1].filePath));
      const before = fs.readdirSync(imagesDir).sort();
      await refuse("POST /staff/arrival-notices/convert", STAFF, { id: d.id, to: "formal" }, /照片「IMG4b\.png」的文件找不到了/);
      assert.deepEqual(fs.readdirSync(imagesDir).sort(), before, "回滚以后图片目录跟转之前一模一样（先补出来的那个新文件删掉了）");
      assert.equal((await pm.shipment.findUnique({ where: { id: dShip.id } })).currentStatus, "pendingInbound");
      assert.equal((await opiOf(dShip.orderId)).length, 2, "两条产品图记录都回滚回来了");
      assert.deepEqual((await pm.arrivalNoticeImage.findMany({ where: { noticeId: d.id }, orderBy: { createdAt: "asc" } })).map((i: Row) => i.orderImageId), nImgs.map((i: Row) => i.orderImageId), "到货照片记的运单副本 id 也没变");

      // ③ 只是到货照片丢了、运单那份好好的：照样转正式（运单上的图是全的）
      const c = await prep("IMG3");
      fs.rmSync(c.src);
      await must("POST /staff/arrival-notices/convert", STAFF, { id: c.n.id, to: "formal" });
      opis = await opiOf(c.ship.orderId);
      assert.equal(opis.length, 1);
      assert.ok(fs.existsSync(file(opis[0].filePath)));
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
      /* 上面那段两个请求要是恰好排成先后，第二个会先被应用层查重挡住、提示一模一样 —— 没有唯一索引也能过（dsh 第二轮 C）。
         所以再绕过应用层直接往库里插一条同公司同号的：必须被数据库自己挡下（P2002），证明唯一约束真的在；
         同号别家公司、两条都没填号的，照样插得进去（只管「同公司 + 有号」） */
      let clash: any = null;
      try {
        await pm.arrivalNotice.create({ data: { id: `an_zz_dup_${Date.now()}`, companyId: CO, trackingNo: NO("DUP1"), createdBy: STAFF.userId } });
      } catch (e) { clash = e; }
      assert.equal(clash?.code, "P2002", "数据库上必须有「同公司 + 运单号」唯一约束");
      // 拿这个真的 P2002 喂给接口里翻中文的那个函数：两个请求真撞到数据库那一步时，员工看到的是这句，不是 500（不靠时机）
      assert.throws(
        () => translateUniqueClash(clash),
        (e: any) => e instanceof BusinessError && /另一条到货通知/.test(e.message),
        "撞了唯一约束要翻成「另一条到货通知」那句中文",
      );
      await pm.arrivalNotice.create({ data: { id: `an_zz_dup_other_${Date.now()}`, companyId: CO2, trackingNo: NO("DUP1"), createdBy: OTHER_STAFF.userId } });
      await pm.arrivalNotice.create({ data: { id: `an_zz_null_a_${Date.now()}`, companyId: CO, trackingNo: null, createdBy: STAFF.userId } });
      await pm.arrivalNotice.create({ data: { id: `an_zz_null_b_${Date.now()}`, companyId: CO, trackingNo: null, createdBy: STAFF.userId } });
      await pm.arrivalNotice.deleteMany({ where: { id: { startsWith: "an_zz_" } } });
    });

    // ⚠️ 死锁是看时机的，4 轮不保证每次都撞上 —— 这一项只是兜底。锁序真正的防线是 test:lock-order 第 12 项（去函数体里核锁的先后）
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

    await check("N19e 两个人同时改同一条：后存的被挡、不会把先存的盖掉；同事点「标已通知」/ 传照片不算冲突；老页面不带 base 照旧能存", async () => {
      // 跟页面 draftToBody(draftOf(item)) 一个样：数字是文字、空的是 null
      const s = (v: unknown) => (v === null || v === undefined ? null : String(v));
      const baseOf = (it: Row) => ({
        clientId: it.clientId, trackingNo: it.trackingNo, itemName: it.itemName, packageCount: s(it.packageCount), weightKg: s(it.weightKg),
        volumeM3: s(it.volumeM3), transportMode: it.transportMode, domesticTrackingNo: it.domesticTrackingNo, warehouseId: it.warehouseId,
        arrivedAt: it.arrivedAt, cargoType: it.cargoType ?? "normal", remark: it.remark, // 货型（F11）：页面 draftOf 没货型 = 普货
      });
      const SAVE = "POST /staff/arrival-notices/save";
      const n = await save(STAFF, { ...full, trackingNo: NO("EDIT1"), itemName: "原品名" });
      const opened = baseOf(n); // 甲、乙同时点开「修改」
      const b1 = await save(STAFF2, { ...opened, id: n.id, itemName: "乙改的", base: opened });
      assert.equal(b1.itemName, "乙改的", "乙先存：没人动过，能存");
      // 2026-10-09 多款产品：品名 / 件数 / 国内单号 / 货型都归「产品明细」，冲突提示统一说「产品明细变了」
      await refuse(SAVE, STAFF, { ...opened, id: n.id, weightKg: "99", base: opened }, /刚刚被同事改过（产品明细变了）/);
      let row = await pm.arrivalNotice.findUnique({ where: { id: n.id } });
      assert.equal(row.itemName, "乙改的", "甲后存被挡，乙改的品名还在");
      assert.equal(Number(row.weightKg), 85.5, "甲的改动一个字都没写进去");

      // 同事这时「标已通知」、传一张照片：资料没变，正在改的人照样能存
      await must("POST /staff/arrival-notices/notify", STAFF, { id: n.id, notified: true });
      await must("POST /staff/arrival-notices/images", STAFF, { noticeId: n.id, fileName: "a.png", mime: "image/png", contentBase64: PNG_1x1 });
      const b2 = await save(STAFF2, { ...baseOf(b1), id: n.id, remark: "乙又改了备注", base: baseOf(b1) });
      assert.equal(b2.remark, "乙又改了备注");

      // 两个人拿同一份 base 同一瞬间存：只进得去一个（锁住以后才比）
      const [r1, r2] = await Promise.all([
        call(SAVE, STAFF, { ...baseOf(b2), id: n.id, packageCount: "13", base: baseOf(b2) }),
        call(SAVE, STAFF2, { ...baseOf(b2), id: n.id, packageCount: "14", base: baseOf(b2) }),
      ]);
      assert.equal([r1, r2].filter((r) => r.status === 200).length, 1, `应该只有一个存上：${r1.status} ${r1.message} / ${r2.status} ${r2.message}`);
      assert.match([r1, r2].find((r) => r.status !== 200)!.message, /产品明细变了/);

      // 上线前打开的老页面不带 base：照旧整份存（不挡）
      const old = await save(STAFF, { ...baseOf(b2), id: n.id, packageCount: "15" });
      assert.equal(old.packageCount, 15);
      // base 读不懂的：当成冲突挡掉，不能因为读不懂就放过去
      await refuse(SAVE, STAFF, { ...baseOf(old), id: n.id, base: "乱写" }, /刚刚被同事改过/);
      await refuse(SAVE, STAFF, { ...baseOf(old), id: n.id, base: { ...baseOf(old), packageCount: 0 } }, /刚刚被同事改过（产品明细变了）/);
      // 哪天仓库名单改了：库里是名单外的老仓库。base 只拿来比、不做填写校验，照样认得；把仓库改成名单里的能存上（不能被一直挡住）
      await pm.arrivalNotice.update({ where: { id: n.id }, data: { warehouseId: "wh_retired_zz" } });
      const retired = { ...baseOf(old), warehouseId: "wh_retired_zz" };
      const moved = await save(STAFF, { ...retired, id: n.id, warehouseId: "wh_yiwu_01", base: retired });
      assert.equal(moved.warehouseId, "wh_yiwu_01");

      // 待入库的单：被挡的那次也不许同步到运单上
      const latest = (await list(STAFF, { keyword: NO("EDIT1") })).items[0];
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "inbound" });
      const stale = baseOf(latest);
      await save(STAFF2, { ...stale, id: n.id, itemName: "乙在待入库时改", base: stale });
      await refuse(SAVE, STAFF, { ...stale, id: n.id, itemName: "甲拿旧的改", base: stale }, /产品明细变了/);
      const ship = await pm.shipment.findFirst({ where: { trackingNo: NO("EDIT1") }, include: { order: true } });
      assert.equal(ship.order.itemName, "乙在待入库时改", "运单那边是乙的，没被甲盖掉");
      row = await pm.arrivalNotice.findUnique({ where: { id: n.id } });
      assert.equal(row.itemName, "乙在待入库时改");
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
    /* ====================== 2026-10-08 第四轮审查（19 条）后端部分的回归 ====================== */

    await check("N20 F01 同一国内单号客户报过预报单：卡片 / 保存回包带 prealertMatches；转运单不带确认 409、什么都不建；带上确认才转；货拉拉 / 短号不乱撞", async () => {
      const pa = await must("POST /client/prealerts", CLIENT, { warehouseId: "wh_yiwu_01", itemName: "预报灯具", packageCount: 2, transportMode: "sea", domesticTrackingNo: "SF9990001112" });
      const paOrder = await pm.order.findFirst({ where: { companyId: CO, orderNo: pa.trackingNo } });
      assert.ok(paOrder, "预报单建出来了");
      const n = await save(STAFF, { ...full, trackingNo: NO("PA1"), domesticTrackingNo: " sf9990001112 " });
      assert.equal(n.prealertMatches.length, 1, "保存回包就要带上（页面马上能显示）");
      assert.deepEqual(n.prealertMatches[0], { orderId: paOrder.id, trackingNo: pa.trackingNo, clientId: CLIENT.userId, domesticTrackingNo: "SF9990001112", received: false });
      const row = (await list(STAFF, { keyword: NO("PA1") })).items[0];
      assert.equal(row.prealertMatches.length, 1, "列表也带");
      const r = await call("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal" });
      assert.equal(r.status, 409, r.message);
      assert.match(r.message, new RegExp(`客户报过预报单（${pa.trackingNo}，唛头 ${CLIENT.userId}）.*预报单审核`));
      assert.match(r.message, /这里再转会多出一张运单/, "还没转的：再转确实会多一张");
      assert.equal(await pm.shipment.count({ where: { trackingNo: NO("PA1") } }), 0, "没确认就一张都不建");
      const r2 = await call("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal", acknowledgedPrealertIds: ["别的id"] });
      assert.equal(r2.status, 409, "确认的不是这张预报单，照样要问");
      const ok2 = (await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal", acknowledgedPrealertIds: [paOrder.id] })).item;
      assert.equal(ok2.convertedTo, "formal");
      assert.equal(ok2.prealertMatches.length, 1, "转完卡片上照样挂着，提醒有两张单要核对");
      // 预报单确认收货以后还撞：received=true
      await must("POST /staff/prealerts/receive", STAFF, { orderId: paOrder.id, packageCount: 2, weightKg: 5, volumeM3: 0.1 });
      const after = (await list(STAFF, { keyword: NO("PA1") })).items[0];
      assert.equal(after.prealertMatches[0].received, true);
      // 不该撞的：货拉拉、不带数字、太短、别家公司的预报单
      for (const dn of ["货拉拉", "SFABCDEF", "12345"]) {
        const x = await save(STAFF, { clientId: CLIENT.userId, domesticTrackingNo: dn });
        assert.deepEqual(x.prealertMatches, [], `「${dn}」不该撞`);
      }
      const other = await save(OTHER_STAFF, { domesticTrackingNo: "SF9990001112" });
      assert.deepEqual(other.prealertMatches, [], "别家公司的预报单不算");
      // 一格里填了好几个号：拆开整号比，拆出来的一个撞上就算
      const multi = await save(STAFF, { clientId: CLIENT_B.userId, domesticTrackingNo: "YT0000000001，SF9990001112" });
      assert.equal(multi.prealertMatches.length, 1, "唛头不一样也提醒（多半是唛头填错）");
      assert.equal(multi.prealertMatches[0].clientId, CLIENT.userId);
      // 待入库 → 转正式：锁里照样重查（带上确认转了待入库，转正式时不带确认照样 409）
      const pin = await save(STAFF, { ...full, trackingNo: NO("PA2"), domesticTrackingNo: "SF9990001112" });
      const r3 = await call("POST /staff/arrival-notices/convert", STAFF, { id: pin.id, to: "inbound" });
      assert.equal(r3.status, 409, "转待入库也要问");
      assert.equal(await pm.shipment.count({ where: { trackingNo: NO("PA2") } }), 0);
      await must("POST /staff/arrival-notices/convert", STAFF, { id: pin.id, to: "inbound", acknowledgedPrealertIds: [paOrder.id] });
      const r4 = await call("POST /staff/arrival-notices/convert", STAFF, { id: pin.id, to: "formal" });
      assert.equal(r4.status, 409, "待入库转正式时不带确认照样要问");
      // 修复第 1 轮：待入库转正式用的是同一张运单，不许说「再转会多出一张」（员工照着点取消，多的那张照样在、货还卡在待入库）
      assert.ok(!r4.message.includes("多出一张运单"), r4.message);
      assert.match(r4.message, /转待入库时已经建过运单，现在可能有两张运单；转正式用的是同一张、不会再多建/, r4.message);
      assert.equal((await pm.shipment.findFirst({ where: { trackingNo: NO("PA2") } })).currentStatus, "pendingInbound", "被挡了就还是待入库");
      await must("POST /staff/arrival-notices/convert", STAFF, { id: pin.id, to: "formal", acknowledgedPrealertIds: [paOrder.id] });
    });

    await check("N21 F02 转了运单但没点「已通知」：照样留在「待通知」页签；点了已通知才出去", async () => {
      const a = await save(STAFF, { ...full, trackingNo: NO("TD1"), domesticTrackingNo: null });
      const b = await save(STAFF, { clientId: CLIENT.userId, trackingNo: NO("TD2") });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: a.id, to: "formal" });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: b.id, to: "inbound" });
      const todo = await list(STAFF, { tab: "todo", keyword: NO("TD") });
      assert.deepEqual(todo.items.map((x: Row) => x.id).sort(), [a.id, b.id].sort(), "两张都要在待通知里");
      assert.equal(todo.counts.todo, 2);
      assert.equal(todo.counts.formal, 1);
      assert.equal(todo.counts.inbound, 1);
      await must("POST /staff/arrival-notices/notify", STAFF, { id: a.id, notified: true });
      const todo2 = await list(STAFF, { tab: "todo", keyword: NO("TD") });
      assert.deepEqual(todo2.items.map((x: Row) => x.id), [b.id]);
      assert.equal(todo2.counts.notified, 0, "「已通知」页签还是只放没转的");
    });

    await check("N22 F03 转待入库没填件数：运单存 null、订单存 0（= 没填）、不建产品行；客户 / 预报单页照旧给 0（R6，前端当没填）；员工 / 超管列表不给数；补上件数后照常", async () => {
      const n = await save(STAFF, { clientId: CLIENT.userId, trackingNo: NO("ZC1"), itemName: "没点数的灯具" });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "inbound" });
      const ship = await pm.shipment.findFirst({ where: { trackingNo: NO("ZC1") }, include: { order: { include: { products: true } } } });
      assert.equal(ship.packageCount, null, "运单的件数存 null，不存 0");
      assert.equal(ship.order.packageCount, 0, "订单那一列不许空，0 = 没填");
      assert.equal(ship.order.products.length, 0, "件数没填先不建产品行（建了只能写 0 箱）");
      const c = (await must("GET /client/orders", CLIENT, {}, { trackingNo: NO("ZC1") })).items.find((x: Row) => x.trackingNo === NO("ZC1"));
      assert.equal(c.packageCount, 0, "客户运单查询：订单件数照旧给 0（0 = 没填，页面 knownPackageCount 显示「—」；统一方案 R6 接口不改成 null）");
      assert.equal(c.itemName, "没点数的灯具", "品名还在订单上");
      const pre = (await must("GET /client/prealerts", CLIENT, {}, { status: "all" })).items.find((x: Row) => x.trackingNo === NO("ZC1"));
      assert.ok(pre, "预报单页也列出来了（status=all）");
      assert.equal(pre.packageCount, 0, "预报单页同上（R6）");
      const st = (await must("GET /staff/shipments", STAFF, {}, { pageSize: "500" })).items.find((x: Row) => x.trackingNo === NO("ZC1"));
      assert.equal(st.packageCount ?? null, null);
      assert.equal(st.totalPackageCount ?? null, null, "员工列表整票件数不能是确定的 0");
      assert.equal(st.canEdit, false, "F08：待入库的单不给编辑");
      const ad = (await must("GET /admin/orders", ADMIN, {}, { pageSize: "500" })).items.find((x: Row) => x.trackingNo === NO("ZC1"));
      assert.equal(ad.packageCount ?? null, null);
      assert.equal(ad.totalPackageCount ?? null, null);
      assert.equal(ad.canEdit, false, "F08：超管列表待入库的单 canEdit=false");
      await save(STAFF, { id: n.id, clientId: CLIENT.userId, trackingNo: NO("ZC1"), itemName: "没点数的灯具", packageCount: 4 });
      const ship2 = await pm.shipment.findFirst({ where: { trackingNo: NO("ZC1") }, include: { order: { include: { products: true } } } });
      assert.equal(ship2.packageCount, 4);
      assert.equal(ship2.order.packageCount, 4);
      assert.equal(ship2.order.products.length, 1);
      assert.equal(ship2.order.products[0].packageCount, 4);
      const c2 = (await must("GET /client/orders", CLIENT, {}, { trackingNo: NO("ZC1") })).items.find((x: Row) => x.trackingNo === NO("ZC1"));
      assert.equal(c2.packageCount, 4, "补上件数后客户看到 4");
      const st2 = (await must("GET /staff/shipments", STAFF, {}, { pageSize: "500" })).items.find((x: Row) => x.trackingNo === NO("ZC1"));
      assert.equal(st2.totalPackageCount, 4, "补上件数后员工列表整票 4");
    });

    await check("N23 F10 没填品名：轨迹弹窗 / 员工超管列表 / 客服「选运单」拿到的品名是 null 不是空串", async () => {
      const n = await save(STAFF, { clientId: CLIENT.userId, trackingNo: NO("NN1") });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "inbound" });
      const tr = await must("GET /client/shipments/track", CLIENT, {}, { trackingNo: NO("NN1") });
      assert.equal(tr.itemName, null);
      const st = (await must("GET /staff/shipments", STAFF, {}, { pageSize: "500" })).items.find((x: Row) => x.trackingNo === NO("NN1"));
      assert.equal(st.itemName ?? null, null);
      const ad = (await must("GET /admin/orders", ADMIN, {}, { pageSize: "500" })).items.find((x: Row) => x.trackingNo === NO("NN1"));
      assert.equal(ad.itemName ?? null, null);
      const refs = await must("GET /client/chat/refs", CLIENT, {}, { q: NO("NN1") });
      const ref = refs.shipments.find((x: Row) => x.no === NO("NN1"));
      assert.ok(ref, "客服对话「选运单」里有这张");
      assert.equal(ref.title, null, "品名 null（页面显示「（没填品名）」），不是空串");
      assert.equal(ref.packageCount, null, "件数 null（不显示「· 0box」）");
    });

    await check("N24 F06 转正式后在运单管理改号：到货通知跟着改（搜新号搜得到、卡片是新号）；旧号能再登记；号对不上的老记录按运单现在的号显示", async () => {
      const n = await save(STAFF, { ...full, trackingNo: NO("RN1"), domesticTrackingNo: null });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal" });
      const ship = await pm.shipment.findFirst({ where: { trackingNo: NO("RN1") } });
      await must("POST /admin/orders/update", ADMIN, { orderId: ship.orderId, itemName: "改号", trackingNo: NO("RN1X") });
      assert.equal((await pm.arrivalNotice.findUnique({ where: { id: n.id } })).trackingNo, NO("RN1X"), "超管改号：到货通知跟着改");
      const hit = await list(STAFF, { keyword: NO("RN1X") });
      assert.deepEqual(hit.items.map((x: Row) => x.id), [n.id], "按新号搜得到");
      const again = await save(STAFF, { clientId: CLIENT_B.userId, trackingNo: NO("RN1") });
      assert.equal(again.trackingNo, NO("RN1"), "旧号放出来了，别人的货能用它登记");
      // 修复第 1 轮：再改回 RN1 = 撞上刚登记、还没转的那条到货通知。两条改号路都要挡、什么都不改（原来放行，那条从此转不了）
      const patchBody = { shipmentId: ship.id, itemName: "改号", productQuantity: 1, packageCount: 12, orderCreatedDate: "2026-10-06", transportMode: "sea", receiverAddressTh: "" };
      for (const [route, who, body] of [
        ["POST /staff/orders/patch-shipment-bundle", STAFF, { ...patchBody, trackingNo: NO("RN1") }],
        ["POST /admin/orders/update", ADMIN, { orderId: ship.orderId, itemName: "改号", trackingNo: NO("RN1") }],
      ] as const) {
        const r = await call(route, who, body);
        assert.equal(r.status, 400, `${route} 改成别的到货通知占着的号应该挡：${r.status} ${r.message}`);
        assert.match(r.message, /已经登记在「到货通知」里了（唛头 ZZARB02，还没转运单）/, r.message);
      }
      assert.equal((await pm.shipment.findUnique({ where: { id: ship.id } })).trackingNo, NO("RN1X"), "挡下来的改号没写进运单");
      assert.equal((await pm.arrivalNotice.findUnique({ where: { id: n.id } })).trackingNo, NO("RN1X"));
      assert.equal((await pm.arrivalNotice.findUnique({ where: { id: again.id } })).trackingNo, NO("RN1"));
      // 号没变、只改别的：不因为到货通知拦（超管不带 trackingNo / 员工带着原号）
      await must("POST /admin/orders/update", ADMIN, { orderId: ship.orderId, itemName: "只改品名" });
      await must("POST /staff/orders/patch-shipment-bundle", STAFF, { ...patchBody, trackingNo: NO("RN1X") });
      // 员工改号那条路
      await must("POST /staff/orders/patch-shipment-bundle", STAFF, { shipmentId: ship.id, trackingNo: NO("RN1Y"), itemName: "改号", productQuantity: 1, packageCount: 12, orderCreatedDate: "2026-10-06", transportMode: "sea", receiverAddressTh: "" });
      assert.equal((await pm.arrivalNotice.findUnique({ where: { id: n.id } })).trackingNo, NO("RN1Y"), "员工改号：到货通知跟着改");
      // 上线前就对不上的老记录：库里还是旧号，列表按运单现在的号显示
      await pm.arrivalNotice.update({ where: { id: n.id }, data: { trackingNo: NO("RN1OLD") } });
      // 2026-10-08 模拟数据测试：按卡片上**显示**的号搜（运单现在的号），库里那个对不上的旧号不再算命中 —— 原来按旧号搜出一张写着别的号的卡
      const stale = (await list(STAFF, { keyword: NO("RN1Y") })).items.find((x: Row) => x.id === n.id);
      assert.ok(stale, "按卡片上显示的号（运单现在的号）搜得到");
      assert.equal(stale.trackingNo, NO("RN1Y"), "卡片显示运单现在的号");
      assert.ok(!(await list(STAFF, { keyword: NO("RN1OLD") })).items.some((x: Row) => x.id === n.id), "按库里对不上的旧号搜不该出来（卡片上没有这个号）");
      assert.equal(stale.shipmentId, ship.id, "页面点「物流轨迹」用这个 id 查");
      // 修复第 1 轮：老数据里运单现在的号被另一条（没转的）到货通知占着 —— 号没变的保存照常过；跟号跳过、点名记 warn，
      // 不去撞唯一约束（撞了 Prisma 会自己打一条 prisma:error）；那条删掉后再存一次，老记录就跟上了
      const squatter = await pm.arrivalNotice.create({ data: { id: "zz_an_squatter", companyId: CO, trackingNo: NO("RN1Y"), createdBy: STAFF.userId } });
      const logs: string[] = [];
      const origErr = console.error; const origWarn = console.warn; const origLog = console.log;
      const origStderr = process.stderr.write.bind(process.stderr); const origStdout = process.stdout.write.bind(process.stdout);
      const grab = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
      console.error = grab; console.warn = grab; console.log = grab;
      (process.stderr as any).write = (c: unknown) => { logs.push(String(c)); return true; };
      (process.stdout as any).write = (c: unknown) => { logs.push(String(c)); return true; };
      try {
        await must("POST /staff/orders/patch-shipment-bundle", STAFF, { ...patchBody, trackingNo: NO("RN1Y"), itemName: "老数据" });
      } finally {
        console.error = origErr; console.warn = origWarn; console.log = origLog;
        (process.stderr as any).write = origStderr; (process.stdout as any).write = origStdout;
      }
      assert.equal((await pm.arrivalNotice.findUnique({ where: { id: n.id } })).trackingNo, NO("RN1OLD"), "号被占着：跳过");
      assert.ok(!logs.some((l) => l.includes("prisma:error")), `跟号不许去撞唯一约束：\n${logs.join("\n")}`);
      assert.ok(logs.some((l) => l.includes("zz_an_squatter")), `跳过要点名是哪条占着：\n${logs.join("\n")}`);
      await pm.arrivalNotice.delete({ where: { id: squatter.id } });
      await must("POST /staff/orders/patch-shipment-bundle", STAFF, { ...patchBody, trackingNo: NO("RN1Y"), itemName: "老数据" });
      assert.equal((await pm.arrivalNotice.findUnique({ where: { id: n.id } })).trackingNo, NO("RN1Y"), "占着的那条没了，再存一次就跟上");
    });

    await check("N25 F09 误删的「待入库」那条轨迹：超管能恢复回来", async () => {
      const n = await save(STAFF, { clientId: CLIENT.userId, trackingNo: NO("RS1") });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "inbound" });
      await save(STAFF, { ...full, id: n.id, trackingNo: NO("RS1"), domesticTrackingNo: null });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal" });
      const ship = await pm.shipment.findFirst({ where: { trackingNo: NO("RS1") }, include: { statusLogs: true } });
      const pendingLog = ship.statusLogs.find((l: Row) => l.toStatus === "pendingInbound");
      assert.ok(pendingLog);
      await must("POST /staff/shipments/track/delete-log", STAFF, { logId: pendingLog.id });
      const deleted = await must("GET /admin/shipments/track/deleted-logs", ADMIN, {}, { trackingNo: NO("RS1") });
      const audit = deleted.items.find((x: Row) => x.log.id === pendingLog.id);
      assert.ok(audit, "超管在「删过的记录」里看得到");
      await must("POST /admin/shipments/track/restore-log", ADMIN, { auditId: audit.auditId });
      assert.equal(await pm.statusLog.count({ where: { id: pendingLog.id } }), 1, "放回来了");
      assert.equal((await pm.shipment.findUnique({ where: { id: ship.id } })).currentStatus, "inWarehouseCN", "状态不动");
    });

    await check("N26 G01 改了唛头：原来的「已通知」改回未通知、回到待通知页签；没唛头补上唛头不动；标已通知时唛头刚被改了就不标", async () => {
      const n = await save(STAFF, { clientId: CLIENT.userId, trackingNo: NO("CHG1") });
      await must("POST /staff/arrival-notices/notify", STAFF, { id: n.id, notified: true, clientId: CLIENT.userId });
      const base = { clientId: CLIENT.userId, trackingNo: NO("CHG1") };
      const moved = await save(STAFF, { id: n.id, clientId: CLIENT_B.userId, trackingNo: NO("CHG1"), base });
      assert.equal(moved.notifiedAt, null, "换了唛头：已通知要清掉");
      assert.ok((await list(STAFF, { tab: "todo", keyword: NO("CHG1") })).items.some((x: Row) => x.id === n.id), "回到待通知");
      // 只改别的、唛头没变：不动已通知
      await must("POST /staff/arrival-notices/notify", STAFF, { id: n.id, notified: true });
      const same = await save(STAFF, { id: n.id, clientId: CLIENT_B.userId, trackingNo: NO("CHG1"), itemName: "补品名" });
      assert.ok(same.notifiedAt, "唛头没变不清");
      // 没唛头 → 补上唛头：不动
      const blank = await save(STAFF, { trackingNo: NO("MK2") });
      await must("POST /staff/arrival-notices/notify", STAFF, { id: blank.id, notified: true });
      const filled = await save(STAFF, { id: blank.id, clientId: CLIENT.userId, trackingNo: NO("MK2") });
      assert.ok(filled.notifiedAt, "原来没唛头的补上唛头，不清");
      // 页面带着「我看到的唛头」去标：唛头已经变了 → 409，不标
      await must("POST /staff/arrival-notices/notify", STAFF, { id: n.id, notified: false });
      const r = await call("POST /staff/arrival-notices/notify", STAFF, { id: n.id, notified: true, clientId: CLIENT.userId });
      assert.equal(r.status, 409, r.message);
      assert.match(r.message, new RegExp(`唛头刚被同事改成「${CLIENT_B.userId}」`));
      assert.equal((await pm.arrivalNotice.findUnique({ where: { id: n.id } })).notifiedAt, null);
      // 待入库那条改唛头：运单挪到 B 名下，已通知照样清
      const p = await save(STAFF, { clientId: CLIENT.userId, trackingNo: NO("MK3") });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: p.id, to: "inbound" });
      await must("POST /staff/arrival-notices/notify", STAFF, { id: p.id, notified: true });
      const pm2 = await save(STAFF, { id: p.id, clientId: CLIENT_B.userId, trackingNo: NO("MK3") });
      assert.equal(pm2.notifiedAt, null);
    });

    await check("N27 G02 超管首页「今日收货体积」：先转待入库、后补体积转正式的，按转正式那天算；直接转正式不算两遍；还在待入库的不算", async () => {
      const vol = async () => (await must("GET /admin/dashboard/overview", ADMIN)).receivedVolumeM3Today as number;
      const v0 = await vol();
      const a = await save(STAFF, { clientId: CLIENT.userId, trackingNo: NO("GV1"), volumeM3: 0.4 });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: a.id, to: "inbound" });
      assert.equal(await vol(), v0, "还在待入库的不算今天进仓");
      // 模拟「昨天转的待入库」：把运单 / 订单建单时间挪到前天
      const ship = await pm.shipment.findFirst({ where: { trackingNo: NO("GV1") } });
      const twoDaysAgo = new Date(Date.now() - 2 * 86400000);
      await pm.shipment.update({ where: { id: ship.id }, data: { createdAt: twoDaysAgo } });
      await pm.order.update({ where: { id: ship.orderId }, data: { createdAt: twoDaysAgo } });
      await save(STAFF, { ...full, id: a.id, trackingNo: NO("GV1"), volumeM3: 2.5, domesticTrackingNo: null });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: a.id, to: "formal" });
      const v1 = await vol();
      assert.ok(Math.abs(v1 - (v0 + 2.5)) < 1e-6, `补齐转正式的 2.5 方要算进今天：${v0} → ${v1}`);
      const b = await save(STAFF, { ...full, trackingNo: NO("GV2"), volumeM3: 1.2, domesticTrackingNo: null });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: b.id, to: "formal" });
      const v2 = await vol();
      assert.ok(Math.abs(v2 - (v1 + 1.2)) < 1e-6, `今天直接转正式的只算一次：${v1} → ${v2}`);
    });

    await check("N28 F11 货型：登记能选，转待入库 / 待入库改 / 转正式都带到订单和产品行；不选 = 普货；乱填挡", async () => {
      await refuse("POST /staff/arrival-notices/save", STAFF, { cargoType: "dangerous" }, /货型只能选普货、商检货、敏感货/);
      const n = await save(STAFF, { ...full, trackingNo: NO("CG1"), domesticTrackingNo: null, cargoType: "sensitive" });
      assert.equal(n.cargoType, "sensitive");
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "inbound" });
      let o = await pm.order.findFirst({ where: { shipments: { some: { trackingNo: NO("CG1") } } }, include: { products: true } });
      assert.equal(o.cargoType, "sensitive", "订单整票货型");
      assert.deepEqual(o.products.map((p: Row) => p.cargoType), ["sensitive"], "产品行货型");
      await save(STAFF, { ...full, id: n.id, trackingNo: NO("CG1"), domesticTrackingNo: null, cargoType: "inspection" });
      o = await pm.order.findUnique({ where: { id: o.id }, include: { products: true } });
      assert.equal(o.cargoType, "inspection", "待入库时改货型同步到订单");
      assert.deepEqual(o.products.map((p: Row) => p.cargoType), ["inspection"]);
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal" });
      o = await pm.order.findUnique({ where: { id: o.id }, include: { products: true } });
      assert.equal(o.cargoType, "inspection");
      // 上线前打开的老页面：body / base 里都没有货型这个键 —— 照旧能存，不挡、不把货型抹成普货
      const old = await save(STAFF, { ...full, trackingNo: NO("CG3"), domesticTrackingNo: null, cargoType: "sensitive" });
      const { cargoType: _drop, ...oldBase } = { ...full, trackingNo: NO("CG3"), domesticTrackingNo: null } as Row;
      const kept = await save(STAFF, { ...full, id: old.id, trackingNo: NO("CG3"), domesticTrackingNo: null, itemName: "老页面改品名", base: oldBase });
      assert.equal(kept.cargoType, "sensitive", "老页面没带货型：沿用库里的");
      assert.equal(kept.itemName, "老页面改品名");
      const plain = await save(STAFF, { ...full, trackingNo: NO("CG2"), domesticTrackingNo: null });
      assert.equal(plain.cargoType, null, "不选 = 普货（存空）");
      await must("POST /staff/arrival-notices/convert", STAFF, { id: plain.id, to: "formal" });
      const o2 = await pm.order.findFirst({ where: { shipments: { some: { trackingNo: NO("CG2") } } } });
      assert.equal(o2.cargoType, "normal");
    });

    await check("N29 G03 照片小图：带小图就存一份、列表给 thumbUrl；不带给原图；小图不像样挡；删照片 / 删到货通知连小图文件一起删；转运单只复制原图", async () => {
      const n = await save(STAFF, { clientId: CLIENT.userId, trackingNo: NO("TH1") });
      await refuse("POST /staff/arrival-notices/images", STAFF, { noticeId: n.id, fileName: "a.png", mime: "image/png", contentBase64: PNG_1x1, thumbBase64: PNG_1x1, thumbMime: "text/plain" }, /照片小图不对/);
      await refuse("POST /staff/arrival-notices/images", STAFF, { noticeId: n.id, fileName: "a.png", mime: "image/png", contentBase64: PNG_1x1, thumbBase64: "A".repeat(200_001), thumbMime: "image/jpeg" }, /照片小图不对/);
      // 修复第 1 轮：HEIC 存下来是破图（电脑浏览器解不开），上传接口挡住（兜上线前打开的老页面）
      await refuse("POST /staff/arrival-notices/images", STAFF, { noticeId: n.id, fileName: "IMG_1.HEIC", mime: "image/heic", contentBase64: PNG_1x1 }, /HEIC 格式（苹果手机原图），电脑浏览器显示不了/);
      await refuse("POST /staff/arrival-notices/images", STAFF, { noticeId: n.id, fileName: "a.heif", mime: "image/HEIF", contentBase64: PNG_1x1 }, /HEIC 格式/);
      const withThumb = (await must("POST /staff/arrival-notices/images", STAFF, { noticeId: n.id, fileName: "a.png", mime: "image/png", contentBase64: PNG_1x1, thumbBase64: PNG_1x1, thumbMime: "image/png" })).item;
      const img = withThumb.images[0];
      assert.notEqual(img.thumbUrl, img.imageUrl, "有小图就给小图");
      const thumbFile = path.join(imagesDir, path.basename(img.thumbUrl));
      assert.ok(fs.existsSync(thumbFile));
      const noThumb = (await must("POST /staff/arrival-notices/images", STAFF, { noticeId: n.id, fileName: "b.png", mime: "image/png", contentBase64: PNG_1x1 })).item;
      assert.equal(noThumb.images[1].thumbUrl, noThumb.images[1].imageUrl, "老页面不带小图：给原图");
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "inbound" });
      const ship = await pm.shipment.findFirst({ where: { trackingNo: NO("TH1") } });
      assert.equal(await pm.orderProductImage.count({ where: { orderId: ship.orderId } }), 2, "运单只拿原图，一张照片一份");
      await must("POST /staff/arrival-notices/images/delete", STAFF, { id: img.id });
      assert.ok(!fs.existsSync(thumbFile), "删照片连小图一起删");
      const m = await save(STAFF, { itemName: "删整条" });
      const mi = (await must("POST /staff/arrival-notices/images", STAFF, { noticeId: m.id, fileName: "c.png", mime: "image/png", contentBase64: PNG_1x1, thumbBase64: PNG_1x1, thumbMime: "image/png" })).item.images[0];
      await must("POST /staff/arrival-notices/delete", STAFF, { id: m.id });
      assert.ok(!fs.existsSync(path.join(imagesDir, path.basename(mi.thumbUrl))), "删到货通知连小图一起删");
    });

    await check("N30 修复第 2 轮 预报单确认收货改了箱数：只有一个产品行时那一行跟着改成实收数（列表 / 详情 / 打印都按它算）；多个产品行不替人猜、照旧不动，列表给整票数让打印那边对账", async () => {
      const one = await must("POST /client/prealerts", CLIENT, { warehouseId: "wh_yiwu_01", transportMode: "sea", products: [{ itemName: "玩具", packageCount: 7 }] });
      await must("POST /staff/prealerts/receive", STAFF, { orderId: one.prealertId, packageCount: 9 });
      const rows1 = await pm.orderProduct.findMany({ where: { orderId: one.prealertId }, select: { packageCount: true } });
      assert.deepEqual(rows1.map((r: Row) => r.packageCount), [9], "客户报 7、实收 9：唯一的产品行要跟着改成 9（原来还是 7，打出「1/7…7/7」少 2 张）");
      assert.equal((await pm.order.findUnique({ where: { id: one.prealertId } })).packageCount, 9);
      const st1 = (await must("GET /staff/shipments", STAFF, {}, { pageSize: "500" })).items.find((x: Row) => x.orderId === one.prealertId || x.trackingNo === one.trackingNo);
      assert.ok(st1, "员工运单列表里要有这张");
      assert.equal(st1.totalPackageCount, 9);
      assert.deepEqual(st1.products.map((p: Row) => p.packageCount), [9]);
      // 箱数没改：产品行不动
      const same = await must("POST /client/prealerts", CLIENT, { warehouseId: "wh_yiwu_01", transportMode: "sea", products: [{ itemName: "杯子", packageCount: 4 }] });
      await must("POST /staff/prealerts/receive", STAFF, { orderId: same.prealertId, weightKg: 12 });
      assert.deepEqual((await pm.orderProduct.findMany({ where: { orderId: same.prealertId } })).map((r: Row) => r.packageCount), [4]);
      // 多个产品行：分不清哪一行多了，不动；列表给整票 9（打印拿它跟产品行合计 7 对账、对不上不打）
      const multi = await must("POST /client/prealerts", CLIENT, { warehouseId: "wh_yiwu_01", transportMode: "sea", products: [{ itemName: "玩具", packageCount: 3 }, { itemName: "文具", packageCount: 4 }] });
      await must("POST /staff/prealerts/receive", STAFF, { orderId: multi.prealertId, packageCount: 9 });
      assert.deepEqual((await pm.orderProduct.findMany({ where: { orderId: multi.prealertId }, orderBy: { sortOrder: "asc" } })).map((r: Row) => r.packageCount), [3, 4]);
      const st2 = (await must("GET /staff/shipments", STAFF, {}, { pageSize: "500" })).items.find((x: Row) => x.trackingNo === multi.trackingNo);
      assert.equal(st2.totalPackageCount, 9);
    });

    await check("N31 修复第 2 轮 撞预报单的粗筛整页共用 take 200 被截断：列表上每一条的提醒跟转运单锁里查到的一样，按列表确认就能转（原来列表没提醒、转单 409，刷新也转不了）", async () => {
      const mk = (id: string, dom: string, t: Date) => ({ id, companyId: CO, clientId: CLIENT.userId, warehouseId: "wh_yiwu_01", approvalStatus: "shipped", itemName: "x", productQuantity: 0, packageCount: 1, packageUnit: "box", transportMode: "sea", receiverNameTh: "", receiverPhoneTh: "", receiverAddressTh: "", domesticTrackingNo: dom, createdAt: t, orderNo: id });
      const now = Date.now();
      const data: Row[] = [mk("zz_an_pa_exact", "QQ7770001", new Date(now - 10_000_000))];
      for (let i = 0; i < 99; i++) data.push(mk(`zz_an_pb_${i}`, `XQQ7770001${String(i).padStart(3, "0")}`, new Date(now - 5_000_000 + i)));
      for (let i = 0; i < 150; i++) data.push(mk(`zz_an_pc_${i}`, `XJJ8880001${String(i).padStart(3, "0")}`, new Date(now - 1_000_000 + i)));
      await pm.order.createMany({ data });
      try {
        const p1 = await save(STAFF, { ...full, trackingNo: NO("TK1"), domesticTrackingNo: "JJ8880001" });
        const p2 = await save(STAFF, { ...full, trackingNo: NO("TK2"), domesticTrackingNo: "QQ7770001" });
        assert.deepEqual(p2.prealertMatches.map((m: Row) => m.orderId), ["zz_an_pa_exact"], "存完回包（只查这一条）撞上最老那张");
        for (const q of [{ keyword: NO("TK"), pageSize: "50" }, { pageSize: "30" }] as Array<Record<string, string>>) {
          const l = await list(STAFF, q);
          const row2 = l.items.find((x: Row) => x.id === p2.id);
          assert.ok(row2 && l.items.some((x: Row) => x.id === p1.id), "两条在同一页");
          assert.deepEqual(row2.prealertMatches.map((m: Row) => m.orderId), ["zz_an_pa_exact"], `列表（${JSON.stringify(q)}）被别条的号挤掉了提醒`);
          assert.equal(l.items.find((x: Row) => x.id === p1.id).prealertMatches.length, 0, "JJ8880001 没有整号相等的预报单");
        }
        const row2 = (await list(STAFF, { pageSize: "30" })).items.find((x: Row) => x.id === p2.id);
        await must("POST /staff/arrival-notices/convert", STAFF, { id: p2.id, to: "formal", acknowledgedPrealertIds: row2.prealertMatches.map((m: Row) => m.orderId) });
      } finally {
        await pm.order.deleteMany({ where: { id: { in: data.map((d) => d.id) } } });
      }
    });

    await check("N32 修复第 2 轮 转正式后在运单管理把唛头改给别的客户：到货通知唛头跟着改、「已通知」清掉回到待通知、按新唛头搜得到；只改别的不动已通知", async () => {
      const n = await save(STAFF, { ...full, trackingNo: NO("XCL1"), domesticTrackingNo: null });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal" });
      await must("POST /staff/arrival-notices/notify", STAFF, { id: n.id, notified: true });
      const ship = await pm.shipment.findFirst({ where: { trackingNo: NO("XCL1") } });
      // 只改品名：唛头没变，「已通知」留着
      await must("POST /admin/orders/update", ADMIN, { orderId: ship.orderId, itemName: "只改品名" });
      let row = await pm.arrivalNotice.findUnique({ where: { id: n.id } });
      assert.equal(row.clientId, CLIENT.userId);
      assert.ok(row.notifiedAt, "唛头没变不许清已通知");
      await must("POST /admin/orders/update", ADMIN, { orderId: ship.orderId, itemName: "改唛头", clientId: CLIENT_B.userId });
      assert.equal((await pm.order.findUnique({ where: { id: ship.orderId } })).clientId, CLIENT_B.userId);
      row = await pm.arrivalNotice.findUnique({ where: { id: n.id } });
      assert.equal(row.clientId, CLIENT_B.userId, "到货通知的唛头要跟着改（原来还是旧客户）");
      assert.equal(row.notifiedAt, null, "通知的是旧客户：改回未通知");
      assert.equal(row.notifiedBy, null);
      assert.equal(row.notifiedByName, null);
      assert.ok(Math.abs(new Date(row.updatedAt).getTime() - Date.now()) < 120_000, `updatedAt 写歪了（时区？）：${row.updatedAt}`);
      const todo = await list(STAFF, { tab: "todo", keyword: CLIENT_B.userId });
      assert.ok(todo.items.some((x: Row) => x.id === n.id), "回到「待通知」、按新唛头搜得到");
      assert.equal(todo.items.find((x: Row) => x.id === n.id).clientId, CLIENT_B.userId);
    });

    await check("N33 修复第 2 轮 到货照片只收电脑上显示得了的格式：TIFF / SVG 挡住说清楚，一张都不存；类型大小写不同照样收", async () => {
      const n = await save(STAFF, { clientId: CLIENT.userId, trackingNo: NO("FMT1") });
      for (const [fileName, mime] of [["scan.tif", "image/tiff"], ["logo.svg", "image/svg+xml"], ["a.ico", "image/x-icon"]]) {
        await refuse("POST /staff/arrival-notices/images", STAFF, { noticeId: n.id, fileName, mime, contentBase64: PNG_1x1 }, /电脑上显示不了，只能传 JPG \/ PNG \/ GIF \/ WebP \/ BMP/);
      }
      assert.equal(await pm.arrivalNoticeImage.count({ where: { noticeId: n.id } }), 0, "挡下来的一张都不能存");
      const ok1 = (await must("POST /staff/arrival-notices/images", STAFF, { noticeId: n.id, fileName: "a.png", mime: "IMAGE/PNG", contentBase64: PNG_1x1 })).item;
      assert.equal(ok1.images.length, 1);
      assert.ok(ok1.images[0].imageUrl.endsWith(".png"), `大写类型也要按 .png 存：${ok1.images[0].imageUrl}`);
    });

    await check("N34 修复第 3 轮 一人在运单管理改号、另一人同一瞬间用新号登记 / 改到货通知：只能有一边成功（原来两边都存上，那条到货通知从此转不了、转出运单的那条也跟不上新号）", async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const tally: string[] = [];
      let i = 0;
      for (const route of ["admin", "staff", "admin-edit", "staff-edit"] as const) for (const delay of [0, 5]) for (let k = 0; k < 4; k++) {
        i++;
        const a = await save(STAFF, { ...full, trackingNo: NO(`R3A${i}`), domesticTrackingNo: null });
        await must("POST /staff/arrival-notices/convert", STAFF, { id: a.id, to: "formal" });
        const ship = await pm.shipment.findFirst({ where: { trackingNo: NO(`R3A${i}`) } });
        const X = NO(`R3X${i}`);
        // 「改」那一种：B 先用别的号登记好（没转），再在同一瞬间把 B 的号改成 X
        const pre = route.endsWith("-edit") ? await save(STAFF2, { clientId: CLIENT_B.userId, trackingNo: NO(`R3B${i}`) }) : null;
        const rename = () => route.startsWith("admin")
          ? call("POST /admin/orders/update", ADMIN, { orderId: ship.orderId, trackingNo: X })
          : call("POST /staff/orders/patch-shipment-bundle", STAFF, { shipmentId: ship.id, trackingNo: X, itemName: "灯具", productQuantity: 1, packageCount: 12, orderCreatedDate: "2026-10-06", transportMode: "sea", receiverAddressTh: "" });
        const register = () => call("POST /staff/arrival-notices/save", STAFF2, { ...(pre ? { id: pre.id } : {}), clientId: CLIENT_B.userId, trackingNo: X });
        const [ren, reg] = await Promise.all([rename(), sleep(delay).then(register)]);
        const tag = `${route}@${delay}ms#${k}: 改号 ${ren.status} / 登记 ${reg.status}`;
        tally.push(tag);
        assert.equal([ren.status, reg.status].filter((st) => st === 200).length, 1, `${tag} —— 只能有一边成功（${ren.message} | ${reg.message}）`);
        const shipNow = (await pm.shipment.findUnique({ where: { id: ship.id } })).trackingNo;
        const aNow = (await pm.arrivalNotice.findUnique({ where: { id: a.id } })).trackingNo;
        const holders = await pm.arrivalNotice.findMany({ where: { companyId: CO, trackingNo: X }, select: { id: true } });
        if (ren.status === 200) {
          assert.match(reg.message, /已经有运单了/, tag);
          assert.equal(shipNow, X, tag);
          assert.equal(aNow, X, `${tag}：转出运单的那条要跟上新号`);
          assert.deepEqual(holders.map((h: Row) => h.id), [a.id], `${tag}：X 只能是转出运单的那条`);
        } else {
          assert.match(ren.message, /已经登记在「到货通知」里了/, tag);
          assert.equal(shipNow, NO(`R3A${i}`), `${tag}：挡下来的改号没写进运单`);
          assert.equal(aNow, NO(`R3A${i}`), tag);
          assert.equal(holders.length, 1, tag);
          assert.notEqual(holders[0].id, a.id, tag);
        }
      }
      assert.ok(tally.length === 32, `跑了 ${tally.length} 轮`);
    });

    await check("N35 修复第 3 轮 跟号写进去的必须是写的那一刻运单上的号：跟号排在锁后面时运单又被改了（X → Y），到货通知最后是 Y，不能把读到的旧号 X 写回去占着", async () => {
      const a = await save(STAFF, { ...full, trackingNo: NO("R3F1"), domesticTrackingNo: null });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: a.id, to: "formal" });
      const ship = await pm.shipment.findFirst({ where: { trackingNo: NO("R3F1") } });
      const { followShipmentTrackingNos } = await import("../apps/api/src/modules/arrival-notices/follow-tracking-no");
      // 第一个人把运单改成 X 并提交（直接改库，模拟改号事务已提交）；他的跟号这时才开始跑
      await pm.shipment.update({ where: { id: ship.id }, data: { trackingNo: NO("R3F1X") } });
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let locked!: () => void;
      const lockedP = new Promise<void>((r) => { locked = r; });
      // 有人正拿着这条到货通知的行锁（比如同事正在点它的「已通知」/ 转运单），第一个人的跟号得排队
      const holder = pm.$transaction(async (tx: any) => {
        await tx.$queryRaw`SELECT id FROM arrival_notices WHERE id = ${a.id} FOR UPDATE`;
        locked();
        await gate;
      }, { timeout: 20000, maxWait: 10000 });
      await lockedP;
      let follow1Done = false;
      const follow1 = followShipmentTrackingNos(CO, [ship.id]).then(() => { follow1Done = true; });
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(follow1Done, false, "跟号应该在排队等行锁");
      // 排队期间第二个人把运单改成 Y 并提交
      await pm.shipment.update({ where: { id: ship.id }, data: { trackingNo: NO("R3F1Y") } });
      release();
      await holder;
      await follow1;
      assert.equal((await pm.arrivalNotice.findUnique({ where: { id: a.id } })).trackingNo, NO("R3F1Y"), "到货通知要是运单现在的号 Y，不是第一个人读到的 X");
      // X 已经空出来：别人能用它登记
      const reuse = await save(STAFF2, { clientId: CLIENT_B.userId, trackingNo: NO("R3F1X") });
      assert.equal(reuse.trackingNo, NO("R3F1X"));
    });

    await check("N36 修复第 4 轮 跨公司：运单号全库唯一，改号撞上别家还没转（或转出的运单已被删）的到货通知也挡、提示不说是哪家；别家转过、运单还在的旧记录不挡；同一瞬间别家用同一个号登记只能成一边", async () => {
      const a = await save(STAFF, { ...full, trackingNo: NO("XC1"), domesticTrackingNo: null });
      await must("POST /staff/arrival-notices/convert", STAFF, { id: a.id, to: "formal" });
      const ship = await pm.shipment.findFirst({ where: { trackingNo: NO("XC1") } });
      const patchBody = { shipmentId: ship.id, itemName: "灯具", productQuantity: 1, packageCount: 12, orderCreatedDate: "2026-10-06", transportMode: "sea", receiverAddressTh: "" };
      const renameVia = (route: "admin" | "staff", no: string) => route === "admin"
        ? call("POST /admin/orders/update", ADMIN, { orderId: ship.orderId, trackingNo: no })
        : call("POST /staff/orders/patch-shipment-bundle", STAFF, { ...patchBody, trackingNo: no });
      // ① 别家登记了、还没转：两条改号路都挡（原来放行，别家那条从此转正式 / 转待入库都报「已经被用过了」）
      const foreign = await save(OTHER_STAFF, { clientId: OTHER_CLIENT.userId, trackingNo: NO("XCO") });
      // ② 别家转出的运单已经被删了（到货通知回到「没转」、可以按这个号重转）：也挡
      await pm.arrivalNotice.create({ data: { id: "zz_an_xc_gone", companyId: CO2, clientId: OTHER_CLIENT.userId, trackingNo: NO("XCG"), convertedTo: "formal", shipmentId: "zz_an_xc_deleted_ship", createdBy: OTHER_STAFF.userId } });
      for (const route of ["admin", "staff"] as const) for (const no of [NO("XCO"), NO("XCG")]) {
        const r = await renameVia(route, no);
        assert.equal(r.status, 400, `${route} 改成 ${no}（别家到货通知占着）应该挡：${r.status} ${r.message}`);
        assert.match(r.message, new RegExp(`运单号 ${no} 已经被用过了`), r.message);
        assert.ok(!r.message.includes(OTHER_CLIENT.userId) && !r.message.includes(CO2), `提示不能说出别家的唛头 / 公司：${r.message}`);
      }
      assert.equal((await pm.shipment.findUnique({ where: { id: ship.id } })).trackingNo, NO("XC1"), "挡下来的改号没写进运单");
      assert.equal((await pm.arrivalNotice.findUnique({ where: { id: a.id } })).trackingNo, NO("XC1"));
      // 别家那条照样转得了
      await must("POST /staff/arrival-notices/convert", OTHER_STAFF, { id: foreign.id, to: "inbound" });
      // ③ 别家转过、运单还在，只是库里的号是旧的（运单后来改了号）：这个旧号不挡 —— 别家那条显示的是它运单现在的号，不会再按旧号转
      const otherShip = await pm.shipment.findFirst({ where: { trackingNo: NO("XCO") } });
      await pm.arrivalNotice.create({ data: { id: "zz_an_xc_stale", companyId: CO2, clientId: OTHER_CLIENT.userId, trackingNo: NO("XCS"), convertedTo: "inbound", shipmentId: otherShip.id, createdBy: OTHER_STAFF.userId } });
      await must("POST /staff/orders/patch-shipment-bundle", STAFF, { ...patchBody, trackingNo: NO("XCS") });
      assert.equal((await pm.shipment.findUnique({ where: { id: ship.id } })).trackingNo, NO("XCS"));
      await pm.arrivalNotice.deleteMany({ where: { id: { in: ["zz_an_xc_gone", "zz_an_xc_stale"] } } });

      // ④ 同一瞬间：本公司改号成 X、别家用 X 登记 —— 号锁不分公司排队，只能成一边（原来 10 次 10 次两边都存上）
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      let i = 0;
      for (const route of ["admin", "staff"] as const) for (const delay of [0, 5]) for (let k = 0; k < 3; k++) {
        i++;
        const before = (await pm.shipment.findUnique({ where: { id: ship.id } })).trackingNo;
        const X = NO(`XCR${i}`);
        const [ren, reg] = await Promise.all([renameVia(route, X), sleep(delay).then(() => call("POST /staff/arrival-notices/save", OTHER_STAFF, { clientId: OTHER_CLIENT.userId, trackingNo: X }))]);
        const tag = `${route}@${delay}ms#${k}: 改号 ${ren.status} / 别家登记 ${reg.status}`;
        assert.equal([ren.status, reg.status].filter((st) => st === 200).length, 1, `${tag} —— 只能有一边成功（${ren.message} | ${reg.message}）`);
        const shipNow = (await pm.shipment.findUnique({ where: { id: ship.id } })).trackingNo;
        const foreignHolders = await pm.arrivalNotice.count({ where: { companyId: CO2, trackingNo: X } });
        if (ren.status === 200) {
          assert.match(reg.message, /已经被用过了/, tag);
          assert.equal(shipNow, X, tag);
          assert.equal(foreignHolders, 0, `${tag}：别家不能再登记上 X`);
        } else {
          assert.match(ren.message, /已经被用过了/, tag);
          assert.equal(shipNow, before, `${tag}：挡下来的改号没写进运单`);
          assert.equal(foreignHolders, 1, tag);
        }
      }
    });
    /* ====================== 2026-10-09 多款产品（老板 10-08「到货通知只能填一款产品，很多时候有好几款」） ====================== */
    // 一款产品（页面 draftToBody 发的样子：没填的是 null）
    const P = (o: Row = {}): Row => ({ itemName: null, packageCount: null, lengthCm: null, widthCm: null, heightCm: null, productQuantity: null, weightKg: null, cargoType: "normal", domesticTrackingNo: null, ...o });
    const ticket = { clientId: CLIENT.userId, transportMode: "sea", warehouseId: "wh_yiwu_01", arrivedAt: "2026-10-09" };
    const SAVE_URL = "POST /staff/arrival-notices/save";
    const dbProducts = (noticeId: string) => pm.arrivalNoticeProduct.findMany({ where: { noticeId }, orderBy: { sortOrder: "asc" } });

    await check("N37 两款保存：回包 / 列表按顺序带两款；主表镜像列 = 品名拼起来、件数合计、国内单号用「、」拼（旧代码拆得开）、货型取最严；调换顺序重存；删通知产品行跟着删", async () => {
      const n = await save(STAFF, { ...ticket, trackingNo: NO("MP1"), weightKg: 85, volumeM3: 0.62, products: [
        P({ itemName: "灯具", packageCount: "12", domesticTrackingNo: "SF1234567890" }),
        P({ itemName: "鞋", packageCount: 5, cargoType: "sensitive", domesticTrackingNo: "YT9876543210" }),
      ] });
      assert.deepEqual(n.products.map((p: Row) => [p.itemName, p.packageCount, p.cargoType, p.domesticTrackingNo]), [["灯具", 12, "normal", "SF1234567890"], ["鞋", 5, "sensitive", "YT9876543210"]]);
      assert.deepEqual(Object.keys(n.products[0]).sort(), ["cargoType", "domesticTrackingNo", "heightCm", "itemName", "lengthCm", "packageCount", "productQuantity", "weightKg", "widthCm"], "产品不带 id");
      assert.equal(n.itemName, "灯具 / 鞋", "顶层品名给老页面看：拼起来");
      assert.equal(n.packageCount, 17);
      assert.equal(n.domesticTrackingNo, "SF1234567890、YT9876543210");
      assert.equal(n.cargoType, "sensitive", "顶层货型取最严");
      assert.equal(n.weightKg, 85, "没填单箱重：整票重量用手填的");
      assert.equal(n.volumeM3, 0.62);
      const row = await pm.arrivalNotice.findUnique({ where: { id: n.id } });
      assert.equal(row.itemName, "灯具 / 鞋");
      assert.equal(row.packageCount, 17);
      assert.equal(row.domesticTrackingNo, "SF1234567890、YT9876543210");
      assert.equal(row.cargoType, "sensitive");
      const { domesticNoTokens } = await import("../apps/api/src/modules/arrival-notices/routes");
      assert.deepEqual(domesticNoTokens(row.domesticTrackingNo), ["SF1234567890", "YT9876543210"], "回滚后旧代码撞预报单要拆得开");
      const rows = await dbProducts(n.id);
      assert.deepEqual(rows.map((p: Row) => [p.sortOrder, p.companyId, p.itemName]), [[0, CO, "灯具"], [1, CO, "鞋"]]);
      const listed = (await list(STAFF, { keyword: NO("MP1") })).items.find((x: Row) => x.id === n.id);
      assert.deepEqual(listed.products, n.products, "列表跟回包一样");
      const swapped = await save(STAFF, { ...ticket, id: n.id, trackingNo: NO("MP1"), weightKg: 85, volumeM3: 0.62, products: [...n.products].reverse() });
      assert.deepEqual(swapped.products.map((p: Row) => p.itemName), ["鞋", "灯具"]);
      assert.deepEqual((await dbProducts(n.id)).map((p: Row) => [p.sortOrder, p.itemName]), [[0, "鞋"], [1, "灯具"]]);
      const gone = await save(STAFF, { products: [P({ itemName: "要删的" }), P({ itemName: "要删的2" })] });
      await must("POST /staff/arrival-notices/delete", STAFF, { id: gone.id });
      assert.equal(await pm.arrivalNoticeProduct.count({ where: { noticeId: gone.id } }), 0, "删通知产品行跟着删");
    });

    await check("N38 每款的校验：两款及以上报「第N款」（按请求里原来的位置，空白款也数）、只有一款跟原来一字不差；第 51 款拒；格式不对拒；合计溢出拒；空白款丢掉、sort_order 重编", async () => {
      const before = await pm.arrivalNotice.count({ where: { companyId: CO } });
      const bad: Array<[Row, RegExp]> = [
        [{ products: [P({ itemName: "灯具", packageCount: 1 }), P({ packageCount: 0 })] }, /^第2款件数必须是正整数$/],
        [{ products: [P(), P({ packageCount: 2.5 })] }, /^第2款件数必须是正整数$/],
        [{ products: [P({ itemName: "灯具" }), P({ weightKg: "0.001" })] }, /^第2款单箱重不能小于 0\.01/],
        [{ products: [P(), P({ lengthCm: -1 })] }, /^第2款长\(cm\)必须是不小于 0 的数字$/],
        [{ products: [P(), P(), P({ heightCm: 1e8 })] }, /^第3款高\(cm\)太大了/],
        [{ products: [P({ productQuantity: "1.5" }), P()] }, /^第1款单箱数量必须是正整数$/],
        [{ products: [P({ cargoType: "dangerous" }), P()] }, /^第1款货型只能选普货、商检货、敏感货$/],
        [{ products: [P(), P({ domesticTrackingNo: "x".repeat(101) })] }, /^第2款国内快递单号太长了/],
        [{ products: [P({ itemName: "x".repeat(201) })] }, /^品名太长了（最多 200 个字）$/],
        [{ products: [P({ packageCount: 0 })] }, /^件数必须是正整数$/],
        [{ products: Array.from({ length: 51 }, () => P()) }, /一条到货通知最多 50 款产品/],
        [{ products: "灯具" }, /产品明细格式不对，请刷新页面/],
        [{ products: { itemName: "灯具" } }, /产品明细格式不对/],
        [{ products: [P({ itemName: "灯具" }), null] }, /产品明细格式不对/],
        [{ products: [["灯具"]] }, /产品明细格式不对/],
        [{ products: [P({ itemName: "a", packageCount: 2000000000 }), P({ itemName: "b", packageCount: 2000000000 })] }, /件数合计 4000000000 超过了系统上限/],
        [{ products: [P({ itemName: "a", packageCount: 2000, weightKg: 99999999 })] }, /总重量算出来是/],
      ];
      for (const [body, re] of bad) await refuse(SAVE_URL, STAFF, body, re);
      assert.equal(await pm.arrivalNotice.count({ where: { companyId: CO } }), before, "填错的一条都不能存进去");
      // 正好 50 款能存
      const fifty = await save(STAFF, { products: Array.from({ length: 50 }, (_, i) => P({ itemName: `款${i + 1}` })) });
      assert.equal(fifty.products.length, 50);
      // 空白款：页面「＋ 加一款」后什么都没填的那几行丢掉，剩下的从 0 重新编号
      const n = await save(STAFF, { products: [P(), P({ itemName: "灯具", packageCount: 2 }), P({ domesticTrackingNo: "   " }), P({ cargoType: "inspection" })] });
      assert.deepEqual(n.products.map((p: Row) => [p.itemName, p.cargoType]), [["灯具", "normal"], [null, "inspection"]], "只有货型不是普货的那款不算空白");
      assert.deepEqual((await dbProducts(n.id)).map((p: Row) => p.sortOrder), [0, 1]);
      // products: [] 合法 = 一款都没登记
      const none = await save(STAFF, { products: [] });
      assert.deepEqual(none.products, []);
      assert.equal(none.itemName, null);
      assert.equal(none.packageCount, null);
    });

    await check("N39 没品名的款能存；转正式时按款点名（第2款品名），什么都不建", async () => {
      const n = await save(STAFF, { ...ticket, trackingNo: NO("MP3"), weightKg: 10, volumeM3: 0.1, products: [P({ itemName: "灯具", packageCount: 2 }), P({ packageCount: 3 })] });
      assert.deepEqual(n.products.map((p: Row) => [p.itemName, p.packageCount]), [["灯具", 2], [null, 3]]);
      await refuse("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal" }, /^转正式运单还缺：第2款品名。先点「修改」补上再转$/);
      const m = await save(STAFF, { ...ticket, trackingNo: NO("MP3B"), products: [P({ itemName: "灯具" }), P({ packageCount: 3 })] });
      await refuse("POST /staff/arrival-notices/convert", STAFF, { id: m.id, to: "formal" }, /^转正式运单还缺：第2款品名、第1款件数、重量、体积。/);
      assert.equal(await pm.shipment.count({ where: { trackingNo: { in: [NO("MP3"), NO("MP3B")] } } }), 0);
    });

    await check("N40 待入库时第 2 款没件数：运单件数 null、订单件数 0、一行产品都不建（不只建齐的那款）、订单品名「灯具 / 鞋」；补上件数后两行、件数 17、订单品名「灯具」、产品数量 / 货型 / 国内单号跟上", async () => {
      const n = await save(STAFF, { clientId: CLIENT.userId, trackingNo: NO("MP4"), products: [P({ itemName: "灯具", packageCount: 12, domesticTrackingNo: "SF4440001" }), P({ itemName: "鞋" })] });
      assert.equal(n.packageCount, null, "有一款没件数：合计是 null");
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "inbound" });
      const load = () => pm.shipment.findFirst({ where: { trackingNo: NO("MP4") }, include: { order: { include: { products: { orderBy: { sortOrder: "asc" } } } } } });
      let ship = await load();
      assert.equal(ship.packageCount, null);
      assert.equal(ship.order.packageCount, 0);
      assert.equal(ship.order.products.length, 0, "要么全建要么全不建：只建灯具那行会少打标签、件数被当成 12");
      assert.equal(ship.order.itemName, "灯具 / 鞋", "没建产品行：订单品名拼起来，列表看得到全部品名");
      assert.equal(ship.order.productQuantity, 0);
      assert.equal(ship.order.domesticTrackingNo, "SF4440001", "订单国内单号取第一个非空的");
      await save(STAFF, { id: n.id, clientId: CLIENT.userId, trackingNo: NO("MP4"), products: [
        P({ itemName: "灯具", packageCount: 12, productQuantity: 10, domesticTrackingNo: "SF4440001" }),
        P({ itemName: "鞋", packageCount: 5, productQuantity: 2, cargoType: "inspection" }),
      ] });
      ship = await load();
      assert.equal(ship.packageCount, 17);
      assert.equal(ship.order.packageCount, 17);
      assert.equal(ship.order.itemName, "灯具", "建了产品行：订单品名取第一款（同「创建订单」）");
      assert.equal(ship.order.productQuantity, 130, "Σ 单箱数量 × 件数（原来同步时不写产品数量）");
      assert.equal(ship.order.cargoType, "inspection", "最严的货型");
      assert.deepEqual(ship.order.products.map((p: Row) => [p.itemName, p.packageCount, p.productQuantity, p.cargoType, p.domesticTrackingNo, p.sortOrder]),
        [["灯具", 12, 10, "normal", "SF4440001", 0], ["鞋", 5, 2, "inspection", "货拉拉", 1]], "国内单号空着写「货拉拉」（同「创建订单」）");
      const st = (await must("GET /staff/shipments", STAFF, {}, { pageSize: "500" })).items.find((x: Row) => x.trackingNo === NO("MP4"));
      assert.equal(st.totalPackageCount, 17);
    });

    await check("N41 两款转正式：订单 / 运单 / 产品行跟员工「创建订单」两款建单逐项一样（品名、件数、重量、体积、产品数量、最严货型、每行字段）；单箱重和尺寸盖掉手填的重量体积", async () => {
      const prods = [
        { itemName: "灯具", packageCount: 12, lengthCm: 60, widthCm: 40, heightCm: 30, productQuantity: 10, weightKg: 5, cargoType: "normal", domesticTrackingNo: "SF1234560001" },
        { itemName: "鞋", packageCount: 5, lengthCm: 50, widthCm: 40, heightCm: 30, productQuantity: 2, weightKg: 5, cargoType: "sensitive", domesticTrackingNo: "YT9876540002" },
      ];
      const n = await save(STAFF, { ...ticket, trackingNo: NO("MPT"), weightKg: 999, volumeM3: 9, products: prods.map((p) => P({ ...p, packageCount: String(p.packageCount), lengthCm: String(p.lengthCm) })) });
      assert.equal(n.weightKg, 85, "Σ 单箱重 × 件数 = 5×12 + 5×5，盖掉手填的 999");
      assert.equal(n.volumeM3, 1.164, "Σ 长×宽×高×件数 = 0.864 + 0.3，盖掉手填的 9");
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal" });
      await must("POST /staff/orders", STAFF, { ...ticket, trackingNo: NO("MPTW"), weightKg: 999, volumeM3: 9, domesticTrackingNo: prods[0].domesticTrackingNo, products: prods });
      const load = (no: string) => pm.shipment.findFirst({ where: { trackingNo: no }, include: { statusLogs: true, order: { include: { products: { orderBy: { sortOrder: "asc" } } } } } });
      const a = await load(NO("MPT"));
      const b = await load(NO("MPTW"));
      const pick = (o: Row, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k] instanceof Object && "toFixed" in o[k] ? String(o[k]) : o[k]]));
      // 同 N14 那份清单
      const orderKeys = ["clientId", "warehouseId", "batchNo", "orderNo", "approvalStatus", "itemName", "productQuantity", "packageCount", "packageUnit", "weightKg", "volumeM3", "receivableCurrency", "shipDate", "domesticTrackingNo", "transportMode", "cargoType", "receiverNameTh", "receiverPhoneTh", "receiverAddressTh", "statusGroup", "paymentStatus"];
      assert.deepEqual(pick(a.order, orderKeys), pick(b.order, orderKeys), "订单");
      assert.equal(a.order.itemName, "灯具");
      assert.equal(a.order.packageCount, 17);
      assert.equal(a.order.productQuantity, 130);
      assert.equal(a.order.cargoType, "sensitive");
      assert.equal(Number(a.order.weightKg), 85);
      assert.equal(Number(a.order.volumeM3), 1.164);
      const shipKeys = ["batchNo", "currentStatus", "currentLocation", "weightKg", "volumeM3", "packageCount", "packageUnit", "transportMode", "domesticTrackingNo", "warehouseId", "remark", "parentTrackingNo"];
      const logKeys = ["fromStatus", "toStatus", "remark", "nextStop", "operatorRole", "operatorName"];
      assert.deepEqual(pick(a.statusLogs[0], logKeys), pick(b.statusLogs[0], logKeys), "轨迹");
      assert.deepEqual(pick(a, shipKeys), pick(b, shipKeys), "运单");
      const prodKeys = ["itemName", "packageCount", "lengthCm", "widthCm", "heightCm", "productQuantity", "cargoType", "domesticTrackingNo", "weightKg", "sortOrder"];
      assert.equal(a.order.products.length, 2);
      assert.deepEqual(a.order.products.map((p: Row) => pick(p, prodKeys)), b.order.products.map((p: Row) => pick(p, prodKeys)), "产品行");
    });

    await check("N42 只有部分款填了单箱重 / 尺寸：只算填了的款（同「创建订单」）；都没填时手填的重量体积留着；清掉单箱重回到手填的", async () => {
      const base = { ...ticket, trackingNo: NO("MP5"), weightKg: 20, volumeM3: 0.5 };
      const n = await save(STAFF, { ...base, products: [P({ itemName: "灯具", packageCount: 2 }), P({ itemName: "鞋", packageCount: 3 })] });
      assert.equal(n.weightKg, 20);
      assert.equal(n.volumeM3, 0.5);
      const w = await save(STAFF, { ...base, id: n.id, products: [P({ itemName: "灯具", packageCount: 2, weightKg: 1.25 }), P({ itemName: "鞋", packageCount: 3, lengthCm: 100, widthCm: 50, heightCm: 20 })] });
      assert.equal(w.weightKg, 2.5, "只有第 1 款有单箱重：2 × 1.25");
      assert.equal(w.volumeM3, 0.3, "只有第 2 款有尺寸：1 × 0.5 × 0.2 × 3");
      const back = await save(STAFF, { ...base, id: n.id, weightKg: "33", products: [P({ itemName: "灯具", packageCount: 2 }), P({ itemName: "鞋", packageCount: 3 })] });
      assert.equal(back.weightKg, 33, "算不出来：用这次手填的");
      assert.equal(back.volumeM3, 0.5);
      // 有单箱重但那款没件数：算不进去
      const noPkg = await save(STAFF, { ...base, id: n.id, weightKg: "7", products: [P({ itemName: "灯具", weightKg: 3 })] });
      assert.equal(noPkg.weightKg, 7);
    });

    await check("N43 冲突检测：同事改了任何一款 → 「产品明细变了」、库里还是同事那份；页面上有一行空白产品、库里一款都没有时不误报；base 的产品明细读不懂当冲突", async () => {
      const n = await save(STAFF, { ...ticket, trackingNo: NO("MP6"), products: [P({ itemName: "灯具", packageCount: 12 }), P({ itemName: "鞋", packageCount: 5 })] });
      const baseOf = (it: Row) => ({ clientId: it.clientId, trackingNo: it.trackingNo, weightKg: it.weightKg, volumeM3: it.volumeM3, transportMode: it.transportMode, warehouseId: it.warehouseId, arrivedAt: it.arrivedAt, remark: it.remark,
        products: it.products.map((p: Row) => ({ ...p, packageCount: p.packageCount === null ? "" : String(p.packageCount) })) });
      const opened = baseOf(n);
      await save(STAFF2, { ...opened, id: n.id, products: [opened.products[0], { ...opened.products[1], packageCount: "6" }], base: opened });
      await refuse(SAVE_URL, STAFF, { ...opened, id: n.id, remark: "甲改备注", base: opened }, /刚刚被同事改过（产品明细变了）/);
      assert.deepEqual((await dbProducts(n.id)).map((p: Row) => p.packageCount), [12, 6], "乙改的还在");
      assert.equal((await pm.arrivalNotice.findUnique({ where: { id: n.id } })).remark, null, "甲的一个字都没写进去");
      // 同事只是把两款调了个顺序：也算变了（顺序就是页面上的「第几款」）
      const now1 = (await list(STAFF, { keyword: NO("MP6") })).items[0];
      const o2 = baseOf(now1);
      await save(STAFF2, { ...o2, id: n.id, products: [...o2.products].reverse(), base: o2 });
      await refuse(SAVE_URL, STAFF, { ...o2, id: n.id, base: o2 }, /产品明细变了/);
      // 空白行：库里 0 款，页面 base 里一行空白产品（页面默认给一款空的）—— 不许误报
      const m = await save(STAFF, { clientId: CLIENT.userId, trackingNo: NO("MP6B"), products: [] });
      const mBase = { ...baseOf(m), products: [P({ packageCount: "" })] };
      const m2 = await save(STAFF, { ...mBase, id: m.id, products: [P(), P({ itemName: "后补的" })], base: mBase });
      assert.deepEqual(m2.products.map((p: Row) => p.itemName), ["后补的"]);
      // base 的数字写成 "12"、库里是 12：同一个数，不算变
      const k = await save(STAFF, { clientId: CLIENT.userId, trackingNo: NO("MP6C"), products: [P({ itemName: "灯具", packageCount: 12, lengthCm: 60, weightKg: 1.5 })] });
      const kBase = { ...baseOf(k), products: [{ ...k.products[0], packageCount: "12", lengthCm: "60", weightKg: "1.50" }] };
      await save(STAFF, { ...kBase, id: k.id, remark: "能存", base: kBase });
      // 读不懂：products 不是数组 / 里面有不是对象的
      for (const products of ["乱写", [null]]) await refuse(SAVE_URL, STAFF, { ...kBase, id: k.id, base: { ...kBase, products } }, /刚刚被同事改过/);
    });

    await check("N44 没刷新的老页面（不带 products）：库里 1 款时能存、长宽高 / 单箱数量 / 单箱重保留、不传货型沿用库里的；库里 2 款时挡住叫他刷新、库里不变；老页面新登记建出 1 款", async () => {
      const a = await save(STAFF, { ...ticket, trackingNo: NO("MP7"), weightKg: 1, volumeM3: 9, products: [P({ itemName: "灯具", packageCount: 2, lengthCm: 60, widthCm: 40, heightCm: 30, productQuantity: 10, weightKg: 5, cargoType: "sensitive", domesticTrackingNo: "SF7770001" })] });
      // 老页面的 base（draftOf 拿的是顶层那几项、数字是文字；F11 之前的页面还没有货型）
      const oldBase = { clientId: a.clientId, trackingNo: a.trackingNo, itemName: a.itemName, packageCount: String(a.packageCount), weightKg: String(a.weightKg), volumeM3: String(a.volumeM3), transportMode: a.transportMode, domesticTrackingNo: a.domesticTrackingNo, warehouseId: a.warehouseId, arrivedAt: a.arrivedAt, remark: a.remark };
      const kept = await save(STAFF, { ...oldBase, id: a.id, itemName: "灯具改", packageCount: "3", base: oldBase });
      assert.deepEqual(kept.products, [{ itemName: "灯具改", packageCount: 3, lengthCm: 60, widthCm: 40, heightCm: 30, productQuantity: 10, weightKg: 5, cargoType: "sensitive", domesticTrackingNo: "SF7770001" }], "老页面看不到的几项不能被抹掉");
      assert.equal(kept.weightKg, 15, "单箱重还在：按 5 × 3 重算");
      assert.equal(kept.volumeM3, 0.216);
      // 老页面带了货型（F11 之后、多款之前的页面）：照它的
      const typed = await save(STAFF, { ...oldBase, id: a.id, itemName: "灯具改", packageCount: "3", cargoType: "normal" });
      assert.equal(typed.products[0].cargoType, "normal");
      // 库里两款：老页面只看得到一款，存了就把第二款抹掉 —— 挡住（排在 base 比对之前，base 对不上也说这一句）
      const b = await save(STAFF, { ...ticket, trackingNo: NO("MP8"), products: [P({ itemName: "灯具", packageCount: 1 }), P({ itemName: "鞋", packageCount: 2 })] });
      await refuse(SAVE_URL, STAFF, { ...ticket, id: b.id, trackingNo: NO("MP8"), itemName: "灯具", packageCount: 1 }, /^这条到货通知现在有 2 款产品，你的页面是旧版的、只显示得了一款，这次没有保存。请刷新页面后再改$/);
      await refuse(SAVE_URL, STAFF, { ...ticket, id: b.id, trackingNo: NO("MP8"), itemName: "灯具", base: { itemName: "对不上" } }, /现在有 2 款产品，你的页面是旧版的/);
      assert.deepEqual((await dbProducts(b.id)).map((p: Row) => [p.itemName, p.packageCount]), [["灯具", 1], ["鞋", 2]], "库里两款一个字不变");
      // 老页面新登记：平铺那四项拼成一款
      const c = await save(STAFF, { clientId: CLIENT.userId, trackingNo: NO("MP9"), itemName: "老页面登记", packageCount: 4, domesticTrackingNo: "SF9990009", cargoType: "inspection" });
      assert.deepEqual((await dbProducts(c.id)).map((p: Row) => [p.itemName, p.packageCount, p.domesticTrackingNo, p.cargoType]), [["老页面登记", 4, "SF9990009", "inspection"]]);
      assert.equal(c.products.length, 1);
    });

    await check("N45 带 products 时平铺的镜像一律不读、不校验：拼起来超过 200 字的品名、乱写的件数 / 货型都不报 400", async () => {
      const n = await save(STAFF, { trackingNo: NO("MP10"), itemName: "长".repeat(300), packageCount: "abc", domesticTrackingNo: "x".repeat(300), cargoType: "乱写", products: [P({ itemName: "灯具" })] });
      assert.equal(n.itemName, "灯具");
      assert.equal(n.packageCount, null);
      assert.equal(n.domesticTrackingNo, null);
    });

    await check("N46 第二款的国内单号撞上客户预报单：保存回包 / 列表带提醒；转运单不确认 409、确认后能转", async () => {
      const pa = await must("POST /client/prealerts", CLIENT, { warehouseId: "wh_yiwu_01", itemName: "预报鞋", packageCount: 2, transportMode: "sea", domesticTrackingNo: "JD7770001234" });
      const paOrder = await pm.order.findFirst({ where: { companyId: CO, orderNo: pa.trackingNo } });
      const n = await save(STAFF, { ...ticket, trackingNo: NO("MP11"), weightKg: 3, volumeM3: 0.1, products: [P({ itemName: "灯具", packageCount: 1, domesticTrackingNo: "SF0000000001" }), P({ itemName: "鞋", packageCount: 1, domesticTrackingNo: " jd7770001234 " })] });
      assert.deepEqual(n.prealertMatches.map((m: Row) => [m.orderId, m.domesticTrackingNo]), [[paOrder.id, "JD7770001234"]], "第二款的号也要比");
      const row = (await list(STAFF, { keyword: NO("MP11") })).items[0];
      assert.equal(row.prealertMatches.length, 1, "列表也带");
      const r = await call("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal" });
      assert.equal(r.status, 409, r.message);
      assert.match(r.message, /国内单号 JD7770001234 客户报过预报单/);
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal", acknowledgedPrealertIds: [paOrder.id] });
      // 新登记时第二款撞：回包就有
      const fresh = await save(STAFF, { products: [P({ itemName: "a" }), P({ domesticTrackingNo: "JD7770001234" })] });
      assert.equal(fresh.prealertMatches.length, 1);
    });

    await check("N47 搜索：按第二款的品名、第二款的国内单号都搜得到", async () => {
      const n = await save(STAFF, { clientId: CLIENT.userId, trackingNo: NO("MP12"), products: [P({ itemName: "普通灯", domesticTrackingNo: "SF1112223" }), P({ itemName: "第二款专搜品名", domesticTrackingNo: "ZT5550009999" })] });
      for (const kw of ["第二款专搜", "zt555000"]) {
        const l = await list(STAFF, { keyword: kw });
        assert.deepEqual(l.items.map((x: Row) => x.id), [n.id], `搜「${kw}」`);
      }
    });

    await check("N48 部署窗口兜底：旧代码登记的（只有主表那几列、没有产品行）列表当一款显示、按它的品名搜得到；新页面一保存就写出产品行", async () => {
      await pm.$executeRawUnsafe(`INSERT INTO arrival_notices (id, company_id, created_by, updated_at, tracking_no, client_id, item_name, package_count, domestic_tracking_no, cargo_type)
        VALUES ('zz_an_mirror', '${CO}', '${STAFF.userId}', now(), '${NO("MP13")}', '${CLIENT.userId}', '旧容器登记的', 6, 'SF6660006', 'inspection')`);
      const it = (await list(STAFF, { keyword: "旧容器登记" })).items.find((x: Row) => x.id === "zz_an_mirror");
      assert.ok(it, "按主表那列品名搜得到");
      assert.deepEqual(it.products, [{ itemName: "旧容器登记的", packageCount: 6, lengthCm: null, widthCm: null, heightCm: null, productQuantity: null, weightKg: null, cargoType: "inspection", domesticTrackingNo: "SF6660006" }]);
      assert.equal(it.packageCount, 6);
      const base = { clientId: it.clientId, trackingNo: it.trackingNo, weightKg: it.weightKg, volumeM3: it.volumeM3, transportMode: it.transportMode, warehouseId: it.warehouseId, arrivedAt: it.arrivedAt, remark: it.remark, products: it.products };
      await save(STAFF, { ...base, id: "zz_an_mirror", products: [...it.products, P({ itemName: "新加一款", packageCount: 1 })], base });
      assert.deepEqual((await dbProducts("zz_an_mirror")).map((p: Row) => [p.itemName, p.packageCount, p.cargoType]), [["旧容器登记的", 6, "inspection"], ["新加一款", 1, "normal"]]);
      // 转运单也认兜底那一款（没有产品行时 fieldsOf 拿主表那几列）
      await pm.$executeRawUnsafe(`INSERT INTO arrival_notices (id, company_id, created_by, updated_at, tracking_no, client_id, item_name, package_count)
        VALUES ('zz_an_mirror2', '${CO}', '${STAFF.userId}', now(), '${NO("MP14")}', '${CLIENT.userId}', '旧容器2', 3)`);
      await must("POST /staff/arrival-notices/convert", STAFF, { id: "zz_an_mirror2", to: "inbound" });
      const ship = await pm.shipment.findFirst({ where: { trackingNo: NO("MP14") }, include: { order: { include: { products: true } } } });
      assert.equal(ship.packageCount, 3);
      assert.deepEqual(ship.order.products.map((p: Row) => [p.itemName, p.packageCount]), [["旧容器2", 3]]);
    });

    await check("N49 单箱数量只填了一部分：转正式时缺的那几款被点名（同「创建订单」全填或全空）；全空照转", async () => {
      const n = await save(STAFF, { ...ticket, trackingNo: NO("MP15"), weightKg: 3, volumeM3: 0.1, products: [P({ itemName: "灯具", packageCount: 2, productQuantity: 10 }), P({ itemName: "鞋", packageCount: 3 }), P({ itemName: "帽", packageCount: 1 })] });
      await refuse("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal" }, /^转正式运单还缺：第2款单箱数量、第3款单箱数量。/);
      const all = await save(STAFF, { ...ticket, id: n.id, trackingNo: NO("MP15"), weightKg: 3, volumeM3: 0.1, products: [P({ itemName: "灯具", packageCount: 2 }), P({ itemName: "鞋", packageCount: 3 }), P({ itemName: "帽", packageCount: 1 })] });
      assert.equal(all.products.length, 3);
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal" });
      const o = await pm.order.findFirst({ where: { shipments: { some: { trackingNo: NO("MP15") } } }, include: { products: true } });
      assert.equal(o.products.length, 3);
      assert.equal(o.productQuantity, 0);
    });
    await check("N51 待入库无产品行：每款国内单号留在运单供查询、显示；订单仍第一款；修改和补齐同步", async () => {
      // scripts 的 tsc 不编 JSX；运行时加载真前端模块（与现有前端行为测试一样，不手抄算法）。
      await pm.agent.create({data:{id:AGENT.agentId,companyId:CO,name:"测试代理",priceNormal:1,priceInspection:1,priceSensitive:1}});
      await pm.user.update({where:{id:CLIENT.userId},data:{agentId:AGENT.agentId}});
      const frontModule = (name: string) => import(path.resolve("apps/web/src/modules/shipment", name));
      const { staffShipmentFilterRow, matchesShipmentFilter, EMPTY_SHIPMENT_FILTER } = await frontModule("export-filter.ts");
      const { buildProductDetailRows } = await frontModule("ShipmentTableGrid.tsx");
      const products = [P({ itemName: "灯具", packageCount: 12, domesticTrackingNo: "ZZDOMFIRST" }), P({ itemName: "鞋", domesticTrackingNo: "ZZDOMSECOND" })];
      const body = { ...ticket, trackingNo: NO("DOMS"), products };
      const n = await save(STAFF, body);
      await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "inbound" });
      async function verify(no: string, expected: string, complete = false) {
        const ship = await pm.shipment.findFirst({ where: { trackingNo: NO("DOMS") }, include: { order: { include: { products: true } } } });
        assert.equal(ship.domesticTrackingNo, expected);
        assert.equal(ship.order.domesticTrackingNo, "ZZDOMFIRST", "订单整串相等筛选口径不改");
        assert.equal(ship.order.products.length, complete ? 2 : 0, "仍然全建或全不建");
        const staff = (await must("GET /staff/shipments", STAFF, {}, { pageSize: "500" })).items.find((s: Row) => s.trackingNo === NO("DOMS"));
        assert.ok(staff);
        assert.equal(matchesShipmentFilter(staffShipmentFilterRow(staff), { ...EMPTY_SHIPMENT_FILTER, domesticTrackingNo: no }), true);
        assert.ok(JSON.stringify(buildProductDetailRows(staff)).includes(no), "列表产品明细要显示第二款单号");
        const clientPage = await must("GET /client/orders", CLIENT, {}, { pageSize:"500" });
        const clientRow = clientPage.items.find((s:Row)=>s.trackingNo===NO("DOMS"));
        assert.ok(clientRow, "真实客户主页面接口有这票");
        assert.ok(clientRow.domesticTrackingNo?.includes(no) || clientRow.products.some((p:Row)=>p.domesticTrackingNo?.includes(no)), "客户主页面能按第二号筛到");
        for(const route of ["GET /agent/shipments","GET /agent/shipments/export-data"]){
          const page=await must(route,AGENT,{}, {keyword:no});
          const row=page.items.find((s:Row)=>s.trackingNo===NO("DOMS"));
          assert.ok(row, route+" 按第二号有结果");
          assert.ok(row.domesticTrackingNo?.includes(no) || row.products.some((p:Row)=>p.domesticTrackingNo?.includes(no)));
          const none=await must(route,{...AGENT,agentId:"zz_unowned_agent"},{},{keyword:no});
          assert.equal(none.items.length,0,"代理隔离");
        }
        const found = await must("GET /client/shipments/search", CLIENT, {}, { domesticTrackingNo: no });
        assert.ok(found.items.some((s: Row) => s.trackingNo === NO("DOMS")), "客户按第二款国内单号搜得到");
        const other = await must("GET /client/shipments/search", CLIENT_B, {}, { domesticTrackingNo: no });
        assert.equal(other.items.some((s: Row) => s.trackingNo === NO("DOMS")), false);
      }
      await verify("ZZDOMSECOND", "ZZDOMFIRST、ZZDOMSECOND");
      products[1].domesticTrackingNo = "ZZDOMCHANGED";
      await save(STAFF, { ...body, id: n.id });
      await verify("ZZDOMCHANGED", "ZZDOMFIRST、ZZDOMCHANGED");
      products[1].packageCount = 5;
      await save(STAFF, { ...body, id: n.id });
      await verify("ZZDOMCHANGED", "ZZDOMFIRST", true);
    });

    await check("N52 回滚旧代码改了镜像或总重体积：新页面保存 / 转换必须拒绝，原数据原样保留", async () => {
      for (const [key,value] of [["itemName","旧版修正名称"],["packageCount",8],["domesticTrackingNo","ZZOLDCHANGED"],["cargoType","sensitive"],["weightKg",12],["volumeM3",0.8]] as const) {
        const body={...ticket,trackingNo:NO("DRIFT"+key),products:[P({itemName:"灯",packageCount:2,weightKg:5,lengthCm:51,widthCm:41,heightCm:31})]};
        const n=await save(STAFF,body);
        await pm.arrivalNotice.update({where:{id:n.id},data:{[key]:value}});
        const before=await pm.arrivalNotice.findUnique({where:{id:n.id},include:{products:true}});
        await refuse("POST /staff/arrival-notices/save",STAFF,{...body,id:n.id,remark:"只改备注"},/数据不一致.*管理员/,409);
        await refuse("POST /staff/arrival-notices/convert",STAFF,{id:n.id,to:"inbound"},/数据不一致.*管理员/,409);
        assert.deepEqual(await pm.arrivalNotice.findUnique({where:{id:n.id},include:{products:true}}),before,"不许猜哪边对，不许覆盖");
      }
    });
    await check("N53 单张通知第二号的精确匹配在粗筛第 201 条以后：列表仍提醒，转运单未确认必须挡", async () => {
      const tag="ZZDEEP7654321";
      const rows=Array.from({length:205},(_,i)=>({id:"zz_an_deep_"+i,companyId:CO,orderNo:"ZZDEEP"+i,clientId:CLIENT.userId,warehouseId:"wh_yiwu_01",receiverNameTh:"",receiverPhoneTh:"",receiverAddressTh:"",itemName:"预报",productQuantity:0,packageCount:1,packageUnit:"box",transportMode:"sea",statusGroup:"unfinished",approvalStatus:"shipped",domesticTrackingNo:i===0?tag:"X"+tag+"Y"+i,createdAt:new Date(1700000000000+i*1000)}));
      await pm.order.createMany({data:rows});
      const n=await save(STAFF,{...ticket,trackingNo:NO("DEEP"),products:[P({itemName:"灯",packageCount:1,domesticTrackingNo:"ZZFIRST98765"}),P({itemName:"鞋",packageCount:1,domesticTrackingNo:tag})]});
      assert.deepEqual(n.prealertMatches.map((r:Row)=>r.orderId),["zz_an_deep_0"]);
      const page=await list(STAFF,{keyword:NO("DEEP")});
      assert.deepEqual(page.items[0].prealertMatches.map((r:Row)=>r.orderId),["zz_an_deep_0"]);
      await refuse("POST /staff/arrival-notices/convert",STAFF,{id:n.id,to:"inbound"},/客户报过预报单/,409);
      await must("POST /staff/arrival-notices/convert",STAFF,{id:n.id,to:"inbound",acknowledgedPrealertIds:["zz_an_deep_0"]});
      await pm.order.deleteMany({where:{id:{startsWith:"zz_an_deep_"}}});
    });

    await check("N50 六位自动体积：新建、只改备注、待入库同步、转正式都存三位；小体积舍成零仍能保存", async () => {
      for (const [suffix, lengthCm, widthCm, heightCm, raw, expected] of [
        ["ROUND", 51, 41, 31, "0.064821", 0.065], ["TINY", 5, 5, 5, "0.000125", 0],
      ] as const) {
        const products = [P({ itemName: "灯具", packageCount: 1, lengthCm, widthCm, heightCm, weightKg: 2 })];
        const body = { ...ticket, trackingNo: NO(suffix), products, volumeM3: raw, weightKg: 2 };
        const n = await save(STAFF, body);
        assert.equal(n.volumeM3, expected);
        await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "inbound" });
        const edited = await save(STAFF, { ...body, id: n.id, base: n, remark: "只改备注" });
        assert.equal(edited.volumeM3, expected);
        const shipment = await pm.shipment.findFirst({ where: { trackingNo: NO(suffix) }, include: { order: true } });
        assert.equal(Number(shipment.volumeM3), expected);
        assert.equal(Number(shipment.order.volumeM3), expected);
        await must("POST /staff/arrival-notices/convert", STAFF, { id: n.id, to: "formal" });
        assert.equal(Number((await pm.arrivalNotice.findUnique({ where: { id: n.id } })).volumeM3), expected);
      }
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
