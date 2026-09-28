/**
 * 2026-09-28 上线前整条分支审查（6 个审查员 + Codex）查出来的后端 bug —— 连库回归（真 handler + 真 PostgreSQL）。
 *
 *   R1 代理的运单列表 / 导出带「已收货」的单（跟客户端一个口径；原来一确认收货，代理那边整票消失）
 *   R2 派送签收单、代理查轨迹：不是标准样子的柜号（本公司柜子表里有、这票货没装过）也抹掉 —— 原来的测试只用标准柜号，改坏了照样绿
 *   R3 运单「柜号」那一格（batchNo）里的号，柜子表里没有，照样抹
 *   R4 先装柜、后补确认收货：父单存「整票实收 − 已装走」；实收比已装走还少 → 400 不写
 *   R5 集货任务轨迹：任务柜号去掉空格的写法、别的任务的柜号（本公司柜号名单）都抹
 *   R6 超管运单列表带整票箱数 totalPackageCount（拆过柜、没产品行的老单原来显示父单剩余）
 *   R7 「本月已签收」按北京时间的月初算（线上后端跑 UTC，原来月初 = 北京 1 号早上 8 点）
 *   R8 新建的柜号马上进抹号名单（原来缓存 60 秒，这 60 秒里客户看得到）
 *   R9 运费低消两个一起存：两个管理员同时保存，不会存成「甲的海运 + 乙的陆运」
 *   —— 以下是修完后 Codex 复看查出来的 ——
 *   R10 柜号跟某个客户的运单号一样：那个客户自己看不抹，别的客户看照抹（原来全公司一律不抹）；去空格写法同理
 *   R11 运单上「装柜号」（shipments.container_no）那一格的号也进抹号名单
 *   R12 确认收货和装柜同时发生不再死锁（订单行改用 FOR NO KEY UPDATE）
 *   R13 父单件数是空的老数据：超管列表不给整票箱数（别变成确定的 0）
 *
 * 只连测试库：DATABASE_URL 不带 neon.tech 的不跑（一次性 docker 库设 AGENT_PORTAL_TEST_ALLOW_DB=1）；
 * 没有 DATABASE_URL 打印「跳过」。测试数据全在假公司 zz_brv_co 下，开跑前、跑完后都清干净；
 * 运费低消是全局配置（不分公司），测之前记下原值、测完原样写回。
 */
import assert from "node:assert/strict";

type Row = Record<string, any>;
type Auth = { userId: string; companyId: string; role: string; name: string; agentId?: string | null };
const CO = "zz_brv_co";
const ADMIN: Auth = { userId: "zz_brv_admin", companyId: CO, role: "admin", name: "审查超管" };
const ADMIN2: Auth = { userId: "zz_brv_admin2", companyId: CO, role: "admin", name: "审查超管二" };
const STAFF: Auth = { userId: "zz_brv_staff", companyId: CO, role: "staff", name: "审查员工" };
const CLIENT: Auth = { userId: "ZZBRVC1", companyId: CO, role: "client", name: "审查客户" };
const AGENT_CLIENT: Auth = { userId: "ZZBRVAC1", companyId: CO, role: "client", name: "代理的客户" };
const AGENT: Auth = { userId: "zz_brv_agent_user", companyId: CO, role: "agent", name: "审查代理", agentId: "zz_brv_agent" };

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

  const routes = new Map<string, Function>();
  const app: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) app[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
  (await import("../apps/api/src/modules/admin/routes")).registerAdminRoutes(app);
  (await import("../apps/api/src/modules/orders/routes")).registerOrderRoutes(app);
  (await import("../apps/api/src/modules/containers/routes")).registerContainerRoutes(app);
  (await import("../apps/api/src/modules/shipments/routes")).registerShipmentRoutes(app);
  (await import("../apps/api/src/modules/admin-ops/routes")).registerAdminOpsRoutes(app);
  (await import("../apps/api/src/modules/agent-portal/routes")).registerAgentPortalRoutes(app);
  (await import("../apps/api/src/modules/consolidation/routes")).registerConsolidationRoutes(app);
  (await import("../apps/api/src/modules/shipping-config/routes")).registerShippingConfigRoutes(app);

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
    await pm.statusLog.deleteMany({ where: { companyId: CO } });
    await pm.orderProduct.deleteMany({ where: { companyId: CO } });
    await pm.shipment.deleteMany({ where: { companyId: CO } });
    await pm.order.deleteMany({ where: { companyId: CO } });
    await pm.consolidationStatusLog.deleteMany({ where: { companyId: CO } });
    await pm.consolidationTask.deleteMany({ where: { companyId: CO } });
    await pm.auditLog.deleteMany({ where: { companyId: CO } });
    await pm.user.deleteMany({ where: { companyId: CO } });
    await pm.agent.deleteMany({ where: { id: "zz_brv_agent" } });
  }

  let passed = 0, failed = 0;
  async function check(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`✅ ${name}`); }
    catch (e: any) { failed++; console.log(`❌ ${name}\n   ${e?.message ?? e}`); }
  }

  const MIN_KEYS = ["min_volume_sea_min_volume", "min_volume_land_min_volume"];
  const minBefore = await pm.aiStatusLabel.findMany({ where: { status: { in: MIN_KEYS } } });

  await cleanup();
  try {
    await pm.agent.create({ data: { id: "zz_brv_agent", companyId: CO, name: "审查代理", priceNormal: 1, priceInspection: 1, priceSensitive: 1 } });
    for (const u of [ADMIN, ADMIN2, STAFF, CLIENT, AGENT_CLIENT]) {
      await pm.user.create({ data: { id: u.userId, companyId: CO, role: u.role, name: u.name, passwordHash: "x", phone: `0${u.userId}`, status: "active", agentId: u === AGENT_CLIENT ? "zz_brv_agent" : null } });
    }
    const recv = { receiverNameTh: "r", receiverPhoneTh: "0", receiverAddressTh: "曼谷" };
    const mkOrder = (id: string, clientId: string, approvalStatus = "approved", extra: Row = {}) => pm.order.create({ data: {
      id, companyId: CO, clientId, warehouseId: "wh_yiwu_01", itemName: "鞋", productQuantity: 0,
      packageCount: 10, packageUnit: "box", transportMode: "sea", weightKg: 100, volumeM3: 1, approvalStatus, ...recv, ...extra,
    } });
    const mkShip = (id: string, orderId: string, trackingNo: string, currentStatus: string, extra: Row = {}) => pm.shipment.create({ data: {
      id, companyId: CO, orderId, trackingNo, currentStatus, warehouseId: "wh_yiwu_01", transportMode: "sea", packageCount: 10, weightKg: 100, volumeM3: 1, ...extra,
    } });
    const mkLog = (id: string, shipmentId: string, remark: string | null, extra: Row = {}) => pm.statusLog.create({ data: {
      id, companyId: CO, shipmentId, operatorId: STAFF.userId, operatorRole: "staff", fromStatus: "loaded", toStatus: "loaded", remark, ...extra,
    } });

    // ---------- R1 ----------
    await mkOrder("zz_brv_r1", AGENT_CLIENT.userId, "shipped");
    await mkShip("zz_brv_r1p", "zz_brv_r1", "ZZBRVR1", "created");
    await check("R1 代理名下客户的预报单确认收货以后，代理的运单列表和导出里照样有这票（原来整票消失）", async () => {
      const r = await call("POST /staff/prealerts/receive", STAFF, { orderId: "zz_brv_r1", packageCount: 10, weightKg: 100, volumeM3: 1 });
      assert.equal(r.status, 200, r.message);
      const list = await call("GET /agent/shipments", AGENT, {}, {});
      assert.equal(list.status, 200, list.message);
      assert.ok(JSON.stringify(list.data).includes("ZZBRVR1"), `代理运单列表里没有已收货的单：${JSON.stringify(list.data).slice(0, 300)}`);
      const exp = await call("GET /agent/shipments/export-data", AGENT, {}, {});
      assert.equal(exp.status, 200, exp.message);
      assert.ok(JSON.stringify(exp.data).includes("ZZBRVR1"), "代理导出里没有已收货的单");
    });

    // ---------- R2 ----------
    // 本公司柜子表里有、这票货没装过的非标准柜号（线上「Y + 10 位数字」那种），只能靠「本公司全部柜号」那一道抹
    await pm.container.create({ data: { companyId: CO, containerNo: "Y2609280002", containerType: "40HQ", currentStatus: "LOADING", transportMode: "sea" } });
    await mkOrder("zz_brv_r2", AGENT_CLIENT.userId);
    await mkShip("zz_brv_r2p", "zz_brv_r2", "ZZBRVR2", "loaded", { packageCount: 0 });
    await mkShip("zz_brv_r2c", "zz_brv_r2", "ZZBRVR2-1", "delivering", { parentTrackingNo: "ZZBRVR2", remark: "随 Y2609280002 走" });
    await mkLog("zz_brv_r2l", "zz_brv_r2p", "原计划装 Y2609280002", { nextStop: "Y2609280002 集港" });
    await pm.adminLastmileOrder.create({ data: { id: "zz_brv_lm2", companyId: CO, deliveryNo: "ZZBRVD2", shipmentId: "zz_brv_r2c", carrierName: "车队", externalTrackingNo: "X", status: "delivering" } });
    await check("R2a 派送签收单（给客户签字那张）：备注里不是标准样子的柜号也抹掉", async () => {
      const r = await call("GET /admin/lastmile/customer-export-data", STAFF, {}, { deliveryNo: "ZZBRVD2", clientId: AGENT_CLIENT.userId });
      assert.equal(r.status, 200, r.message);
      const line = (r.data?.customers?.[0]?.shipments ?? []).find((x: Row) => x.trackingNo === "ZZBRVR2-1");
      assert.ok(line, `导出里没这张子单：${JSON.stringify(r.data).slice(0, 200)}`);
      assert.ok(!String(line.remark).includes("Y2609280002"), `签收单备注还带柜号：${line.remark}`);
    });
    await check("R2b 代理查轨迹：备注、下一站里不是标准样子的柜号也抹掉", async () => {
      const r = await call("GET /agent/shipments/track", AGENT, {}, { trackingNo: "ZZBRVR2" });
      assert.equal(r.status, 200, r.message);
      const text = JSON.stringify(r.data);
      assert.ok(text.includes("原计划装"), `前提不成立：代理轨迹里没这条备注：${text.slice(0, 300)}`);
      assert.ok(!text.includes("Y2609280002"), `代理轨迹里还有柜号：${text.slice(0, 400)}`);
    });

    // ---------- R3 ----------
    await mkOrder("zz_brv_r3", CLIENT.userId, "approved", { batchNo: "L2609280003" });
    await mkShip("zz_brv_r3p", "zz_brv_r3", "ZZBRVR3", "loaded", { batchNo: "L2609280003", remark: "随 L2609280003 走" });
    await mkLog("zz_brv_r3l", "zz_brv_r3p", "柜号 L2609280003 已发车", { nextStop: "L2609280003 凭祥" });
    await check("R3 运单「柜号」那一格填的号（柜子表里没有、不是标准样子）：客户查轨迹、客户运单列表都抹掉", async () => {
      const r = await call("GET /client/shipments/track", CLIENT, {}, { trackingNo: "ZZBRVR3" });
      assert.equal(r.status, 200, r.message);
      assert.ok(!JSON.stringify(r.data).includes("L2609280003"), `客户查轨迹里还有柜号：${JSON.stringify(r.data.timeline ?? []).slice(0, 300)}`);
      const list = await call("GET /client/orders", CLIENT, {}, {});
      const it = (list.data?.items ?? []).find((x: Row) => x.id === "zz_brv_r3");
      assert.ok(it, "客户列表里没这张单");
      assert.ok(!JSON.stringify(it).includes("L2609280003"), `客户运单列表里还有柜号：remark=${it.remark} latest=${it.latestRemark}`);
    });

    // ---------- R4 ----------
    for (const k of ["a", "b", "c"]) {
      await mkOrder(`zz_brv_r4${k}`, CLIENT.userId, "shipped");
      // 先整票装走了：父单剩 0，子单 10 件 / 100 kg / 1 方
      await mkShip(`zz_brv_r4${k}p`, `zz_brv_r4${k}`, `ZZBRVR4${k.toUpperCase()}`, "loaded", { packageCount: 0, weightKg: 0, volumeM3: 0 });
      await mkShip(`zz_brv_r4${k}c`, `zz_brv_r4${k}`, `ZZBRVR4${k.toUpperCase()}-1`, "loaded", { parentTrackingNo: `ZZBRVR4${k.toUpperCase()}` });
    }
    await check("R4a 整票装走后补确认收货（实收正好 10 件 100 kg 1 方）：父单还是 0，不会变回整票（原来变回 10，同一批货能再装一个柜）", async () => {
      const r = await call("POST /staff/prealerts/receive", STAFF, { orderId: "zz_brv_r4a", packageCount: 10, weightKg: 100, volumeM3: 1 });
      assert.equal(r.status, 200, r.message);
      const p = await pm.shipment.findUnique({ where: { id: "zz_brv_r4ap" } });
      assert.equal(p.packageCount, 0); assert.equal(Number(p.weightKg), 0); assert.equal(Number(p.volumeM3), 0);
      const o = await pm.order.findUnique({ where: { id: "zz_brv_r4a" } });
      assert.equal(o.approvalStatus, "received"); assert.equal(o.packageCount, 10);
    });
    await check("R4b 实收比已装走的还少（8 件 < 已装 10 件）→ 400，订单、父单一个字不动", async () => {
      const r = await call("POST /staff/prealerts/receive", STAFF, { orderId: "zz_brv_r4b", packageCount: 8, weightKg: 100, volumeM3: 1 });
      assert.equal(r.status, 400, `应该 400，实际 ${r.status} ${r.message}`);
      assert.match(r.message, /已经装柜/);
      const o = await pm.order.findUnique({ where: { id: "zz_brv_r4b" } });
      assert.equal(o.approvalStatus, "shipped", "被拦的请求把订单标成已收货了");
      const p = await pm.shipment.findUnique({ where: { id: "zz_brv_r4bp" } });
      assert.equal(p.packageCount, 0);
    });
    await check("R4c 实收比已装走的多（12 件 / 120 kg / 1.2 方）：父单存多出来的 2 件 / 20 kg / 0.2 方", async () => {
      const r = await call("POST /staff/prealerts/receive", STAFF, { orderId: "zz_brv_r4c", packageCount: 12, weightKg: 120, volumeM3: 1.2 });
      assert.equal(r.status, 200, r.message);
      const p = await pm.shipment.findUnique({ where: { id: "zz_brv_r4cp" } });
      assert.equal(p.packageCount, 2); assert.equal(Number(p.weightKg), 20); assert.equal(Number(p.volumeM3), 0.2);
    });

    // ---------- R5 ----------
    const TA = await pm.consolidationTask.create({ data: { taskNo: "ZZBRVTA", companyId: CO, clientId: CLIENT.userId, destinationTh: "曼谷", status: "loading", containerNo: "L26 0821 9130" } });
    await pm.consolidationTask.create({ data: { taskNo: "ZZBRVTB", companyId: CO, clientId: AGENT_CLIENT.userId, destinationTh: "曼谷", status: "loading", containerNo: "Y2609280004" } });
    const tLog = (remark: string, sec: number) => pm.consolidationStatusLog.create({ data: {
      taskId: TA.id, companyId: CO, operatorId: STAFF.userId, operatorRole: "staff", operatorName: STAFF.name,
      fromStatus: "loading", toStatus: "shipped", remark, createdAt: new Date(Date.now() - sec * 1000),
    } });
    await tLog("今天随柜 L2608219130 发车", 20);
    await tLog("跟 Y2609280004 一起走", 10);
    await check("R5 集货任务轨迹：本任务柜号去掉空格的写法、别的任务的柜号都抹掉", async () => {
      const r = await call("GET /client/consolidation/tasks/detail", CLIENT, {}, { taskId: TA.id });
      assert.equal(r.status, 200, r.message);
      const text = JSON.stringify(r.data.statusLogs);
      assert.ok(text.includes("发车") && text.includes("一起走"), `前提不成立：轨迹里没这两条：${text.slice(0, 300)}`);
      assert.ok(!text.includes("L2608219130"), `任务柜号（连着写的）露出来了：${text.slice(0, 300)}`);
      assert.ok(!text.includes("Y2609280004"), `别的任务的柜号露出来了：${text.slice(0, 300)}`);
    });

    // ---------- R6 ----------
    await mkOrder("zz_brv_r6", CLIENT.userId);
    await mkShip("zz_brv_r6p", "zz_brv_r6", "ZZBRVR6", "loaded", { packageCount: 30, weightKg: 30, volumeM3: 0.3 });
    await mkShip("zz_brv_r6c", "zz_brv_r6", "ZZBRVR6-1", "loaded", { parentTrackingNo: "ZZBRVR6", packageCount: 70, weightKg: 70, volumeM3: 0.7 });
    await check("R6 超管运单列表：拆过柜、没有产品行的老单带整票箱数 100（原来只有父单剩余 30，列表和导出写「30 件 100 公斤」）", async () => {
      const r = await call("GET /admin/orders", ADMIN, {}, { pageSize: "500" });
      assert.equal(r.status, 200, r.message);
      const it = (r.data?.items ?? []).find((x: Row) => x.trackingNo === "ZZBRVR6");
      assert.ok(it, "列表里没这张单");
      assert.equal(it.totalPackageCount, 100, `整票箱数应是 100，实际 ${it.totalPackageCount}`);
      assert.equal(it.packageCount, 30, "父单剩余那个字段不该变");
    });

    // ---------- R7 ----------
    {
      // 北京时间本月 1 号 00:00 对应的真实时刻（中国没有夏令时，固定 +8）
      const bj = new Date(Date.now() + 8 * 3600_000);
      const monthStart = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), 1) - 8 * 3600_000);
      const mk = async (k: string, at: Date) => {
        await mkOrder(`zz_brv_r7${k}`, CLIENT.userId);
        await mkShip(`zz_brv_r7${k}p`, `zz_brv_r7${k}`, `ZZBRVR7${k.toUpperCase()}`, "delivered");
        await pm.statusLog.create({ data: { id: `zz_brv_r7${k}l`, companyId: CO, shipmentId: `zz_brv_r7${k}p`, operatorId: STAFF.userId, operatorRole: "staff", fromStatus: "outForDelivery", toStatus: "delivered", changedAt: at } });
      };
      await mk("a", new Date(monthStart.getTime() + 30 * 60_000)); // 北京 1 号 00:30 签收 → 算本月
      await mk("b", new Date(monthStart.getTime() - 30 * 60_000)); // 北京上个月最后一天 23:30 → 不算
      await check("R7 本月已签收按北京时间的月初：1 号凌晨 00:30 签收的算本月、上月最后一天 23:30 的不算", async () => {
        const r = await call("GET /client/shipments/overview", CLIENT, {}, {});
        assert.equal(r.status, 200, r.message);
        // 客户 ZZBRVC1 名下已签收的只有这两张（R3、R6 等都不是 delivered）
        assert.equal(r.data.signedThisMonthCount, 1, `应只算 00:30 那张，实际 ${r.data.signedThisMonthCount}（按 UTC 月初算的话 00:30 那张会漏掉）`);
      });
    }

    // ---------- R8 ----------
    await mkOrder("zz_brv_r8", CLIENT.userId);
    await mkShip("zz_brv_r8p", "zz_brv_r8", "ZZBRVR8", "loaded");
    await check("R8 新建的柜号马上进抹号名单：客户刚看过一次（原来会缓存 60 秒），紧接着新建柜、员工写进备注，客户再看就抹掉", async () => {
      const warm = await call("GET /client/shipments/track", CLIENT, {}, { trackingNo: "ZZBRVR8" });
      assert.equal(warm.status, 200, warm.message);
      await pm.container.create({ data: { companyId: CO, containerNo: "Y2609280005", containerType: "40HQ", currentStatus: "LOADING", transportMode: "sea" } });
      await mkLog("zz_brv_r8l", "zz_brv_r8p", "改装 Y2609280005");
      const r = await call("GET /client/shipments/track", CLIENT, {}, { trackingNo: "ZZBRVR8" });
      const text = JSON.stringify(r.data.timeline ?? []);
      assert.ok(text.includes("改装"), `前提不成立：轨迹里没这条：${text.slice(0, 200)}`);
      assert.ok(!text.includes("Y2609280005"), `刚建的柜号露出来了：${text.slice(0, 300)}`);
    });

    // ---------- R9 ----------
    await check("R9 两个管理员同时保存低消（各 20 轮）：存下来的永远是同一个人那一套，不会一半甲一半乙", async () => {
      const read = async () => Object.fromEntries((await pm.aiStatusLabel.findMany({ where: { status: { in: MIN_KEYS } } })).map((r: Row) => [r.status, r.labelZh]));
      await call("POST /admin/shipping/config", ADMIN, { sea_min_volume: "0", land_min_volume: "0" });
      const mixed: string[] = [];
      for (let i = 0; i < 20; i++) {
        const [a, b] = await Promise.all([
          call("POST /admin/shipping/config", ADMIN, { sea_min_volume: "1.1", land_min_volume: "1.1" }),
          call("POST /admin/shipping/config", ADMIN2, { sea_min_volume: "2.2", land_min_volume: "2.2" }),
        ]);
        assert.equal(a.status, 200, a.message); assert.equal(b.status, 200, b.message);
        const v = await read();
        if (v.min_volume_sea_min_volume !== v.min_volume_land_min_volume) mixed.push(`第 ${i + 1} 轮：海运 ${v.min_volume_sea_min_volume} / 陆运 ${v.min_volume_land_min_volume}`);
      }
      assert.deepEqual(mixed, [], `存成了一半甲一半乙：${mixed.join("；")}`);
    });

    // ---------- R10 ----------
    await mkOrder("zz_brv_r10a", CLIENT.userId);
    await mkShip("zz_brv_r10ap", "zz_brv_r10a", "ZZBRVOWN1", "loaded", { remark: "我的单 ZZBRVOWN1、ZZBRVOWN2" });
    await mkOrder("zz_brv_r10b", AGENT_CLIENT.userId);
    await mkShip("zz_brv_r10bp", "zz_brv_r10b", "ZZBRVR10B", "loaded");
    // 写在轨迹备注里（代理查轨迹下发的是轨迹，不带运单自己的备注 —— 写在运单备注上这条等于没测）
    await mkLog("zz_brv_r10bl", "zz_brv_r10bp", "跟 ZZBRVOWN1 拼、跟 ZZBRVOWN2 拼");
    // 两个柜：一个柜号就是客户甲的运单号；另一个存的时候带空格，去掉空格正好是客户甲的另一张运单号
    await pm.container.create({ data: { companyId: CO, containerNo: "ZZBRVOWN1", containerType: "40HQ", currentStatus: "LOADING", transportMode: "sea" } });
    await mkOrder("zz_brv_r10c", CLIENT.userId);
    await mkShip("zz_brv_r10cp", "zz_brv_r10c", "ZZBRVOWN2", "created");
    await pm.consolidationTask.create({ data: { taskNo: "ZZBRVT10", companyId: CO, clientId: AGENT_CLIENT.userId, destinationTh: "曼谷", status: "loading", containerNo: "ZZBRV OWN2" } });
    await check("R10 柜号跟客户甲的运单号一样：客户甲自己看不抹（那是他的运单号），别的客户备注里写了照抹；去空格的写法同理", async () => {
      const mine = await call("GET /client/orders", CLIENT, {}, {});
      const a = (mine.data?.items ?? []).find((x: Row) => x.id === "zz_brv_r10a");
      assert.ok(a, "客户甲列表里没这张单");
      assert.ok(String(a.remark).includes("ZZBRVOWN1") && String(a.remark).includes("ZZBRVOWN2"), `客户甲自己的运单号被抹了：${a.remark}`);
      const other = await call("GET /agent/shipments/track", AGENT, {}, { trackingNo: "ZZBRVR10B" });
      assert.equal(other.status, 200, other.message);
      const text = JSON.stringify(other.data);
      assert.ok(text.includes("拼"), `前提不成立：代理轨迹里没这条备注：${text.slice(0, 300)}`);
      assert.ok(!text.includes("ZZBRVOWN1"), `别的客户看到了这个柜号（它碰巧也是客户甲的运单号）：${text.slice(0, 300)}`);
      assert.ok(!text.includes("ZZBRVOWN2"), `别的客户看到了去空格写法的柜号：${text.slice(0, 300)}`);
    });

    // ---------- R11 ----------
    await mkOrder("zz_brv_r11", CLIENT.userId);
    await mkShip("zz_brv_r11p", "zz_brv_r11", "ZZBRVR11", "loaded", { containerNo: "Y2609280006" });
    await mkLog("zz_brv_r11l", "zz_brv_r11p", "改到 Y2609280006");
    await check("R11 运单上「装柜号」那一格（shipments.container_no）的号也抹", async () => {
      const r = await call("GET /client/shipments/track", CLIENT, {}, { trackingNo: "ZZBRVR11" });
      const text = JSON.stringify(r.data.timeline ?? []);
      assert.ok(text.includes("改到"), `前提不成立：${text.slice(0, 200)}`);
      assert.ok(!text.includes("Y2609280006"), `装柜号露出来了：${text.slice(0, 300)}`);
    });

    // ---------- R12 ----------
    await mkOrder("zz_brv_r12", CLIENT.userId, "shipped");
    await mkShip("zz_brv_r12p", "zz_brv_r12", "ZZBRVR12", "created");
    await check("R12 确认收货跟装柜同一瞬间：两边都成功，不死锁（装柜先锁父单、再插子单要对订单拿外键锁）", async () => {
      const { PrismaClient } = await import("@prisma/client");
      const other = new PrismaClient({ datasources: { db: { url } } });
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      let loadErr = "";
      try {
        // 模拟装柜：锁父单 → 等一会儿（这时确认收货已经锁了订单、在等父单）→ 插子单 → 扣父单
        const loading = other.$transaction(async (tx: any) => {
          await tx.$queryRawUnsafe(`SELECT id FROM shipments WHERE id = 'zz_brv_r12p' FOR UPDATE`);
          await sleep(400);
          await tx.shipment.create({ data: { id: "zz_brv_r12c", companyId: CO, orderId: "zz_brv_r12", trackingNo: "ZZBRVR12-1", parentTrackingNo: "ZZBRVR12", currentStatus: "loaded", warehouseId: "wh_yiwu_01", transportMode: "sea", packageCount: 10, weightKg: 100, volumeM3: 1 } });
          await tx.shipment.update({ where: { id: "zz_brv_r12p" }, data: { packageCount: 0, weightKg: 0, volumeM3: 0 } });
        }, { timeout: 20000 }).catch((e: any) => { loadErr = String(e?.message ?? e); });
        await sleep(100);
        const receive = call("POST /staff/prealerts/receive", STAFF, { orderId: "zz_brv_r12", packageCount: 10, weightKg: 100, volumeM3: 1 });
        const [, r] = await Promise.all([loading, receive]);
        assert.ok(!/deadlock/i.test(loadErr), `装柜那边死锁被中止了：${loadErr.slice(0, 200)}`);
        assert.equal(loadErr, "", `装柜那边失败了：${loadErr.slice(0, 200)}`);
        assert.equal(r.status, 200, `确认收货失败：${r.status} ${r.message}`);
        // 收货在装柜之后拿到父单锁：看得到刚装走的子单，父单存 10 − 10 = 0
        const p = await pm.shipment.findUnique({ where: { id: "zz_brv_r12p" } });
        assert.equal(p.packageCount, 0, `父单应剩 0，实际 ${p.packageCount}`);
      } finally {
        await other.$disconnect();
      }
    });

    // ---------- R13 ----------
    await mkOrder("zz_brv_r13", CLIENT.userId);
    await mkShip("zz_brv_r13p", "zz_brv_r13", "ZZBRVR13", "loaded", { packageCount: null });
    await check("R13 父单件数是空的老数据：超管列表不给整票箱数（页面照旧显示「—」，不变成 0）", async () => {
      const r = await call("GET /admin/orders", ADMIN, {}, { pageSize: "500" });
      const it = (r.data?.items ?? []).find((x: Row) => x.trackingNo === "ZZBRVR13");
      assert.ok(it, "列表里没这张单");
      assert.equal(it.totalPackageCount, undefined, `件数未知却给了整票箱数 ${it.totalPackageCount}`);
    });
  } finally {
    await cleanup();
    await pm.aiStatusLabel.deleteMany({ where: { status: { in: MIN_KEYS } } });
    for (const row of minBefore) await pm.aiStatusLabel.create({ data: row });
    await pm.$disconnect();
  }
  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
