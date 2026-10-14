/**
 * 2026-10-14 全系统审查（Claude 6 个子代理 + Codex + dsh，逐条核实后 16 条）修复 —— 连库回归（真 handler + 真 PostgreSQL）。
 * 清单和核实依据：.audit/2026-10-14/full-review/核实结果.md；每项「改回去就红」的记录在 .audit/2026-10-14/review-fix/。
 *
 *   R1  客户「钱包」流水备注：员工 / 管理员手写原因里的柜号抹掉（旧：原样给客户）
 *   R1b 代理仓库版柜详情：取消原因、状态记录里的柜号抹掉（旧：取消原因原样、「柜号：L…」原样）
 *   R2  建派送单：货不在泰国仓（已入库 / 卸柜中）409、一车都不建、状态不动（旧：200，改成派送中）
 *   R3  普通版集货编辑：带着「打开时有哪几行」，别人刚加的行不会被删（旧：200，别人那行没了）
 *   R4  普通版集货：两人同时删同一张预报单 → 一个 200、一个 404（旧：500）；强制编辑时单子刚被删 → 404（旧：500）
 *   R5  普通版集货取消：记录里的原状态用锁后重读的（旧：点取消那一刻的旧状态）
 *   R6  员工建单 / 客户建预报单 / 确认收货：仓库、运输方式、包装单位只认内部值（旧：中文原样存）
 *   R7  客户建预报单：发货日期「2026-02-31」400（旧：原文存进库）
 *   R8  确认收货改国内单号（带「员工真改过」标记）：运单、唯一一行产品跟着改（旧：只改订单）；老页面不带标记不动运单
 *   R9  超管首页「今日收货体积」：当天进仓当天装柜不往下掉（旧：整票装走就 0）
 *   R10 装柜「可选运单」那份映射带上子单号 / 父单号 / 件数（旧：只有子单 id，页面按父单对不上）
 *   R11 客户按运单 id 找自己的这一票（客服卡片改号后也找得到），别人的 id 找不到
 *   R12 客服对话：整柜卡片显示现在的提单号（旧：一直是发消息那一刻的号）
 *   R13 装柜单号不填时自动编号按北京日期
 *
 * 只连测试库：DATABASE_URL 不带 neon.tech 的不跑（一次性 docker 库设 AGENT_PORTAL_TEST_ALLOW_DB=1）；
 * 没有 DATABASE_URL 打印「跳过」。测试数据全在假公司 zz_rv14_co 下，开跑前、跑完后都清干净。
 * ⚠️ R4 / R5 会对集货任务行加锁卡住别的请求，只能在一次性库上跑或单独跑。
 */
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";

type Row = Record<string, any>;
type Auth = { userId: string; companyId: string; role: string; name: string; agentId: string | null };
const CO = "zz_rv14_co";
const AGENT_ID = "zz_rv14_agent";
const ADMIN: Auth = { userId: "zz_rv14_admin", companyId: CO, role: "admin", name: "超管", agentId: null };
const ADMIN2: Auth = { userId: "zz_rv14_admin2", companyId: CO, role: "admin", name: "超管二", agentId: null };
const STAFF: Auth = { userId: "zz_rv14_staff", companyId: CO, role: "staff", name: "员工", agentId: null };
const C1: Auth = { userId: "ZZRV14C1", companyId: CO, role: "client", name: "客户一", agentId: null };
const C2: Auth = { userId: "ZZRV14C2", companyId: CO, role: "client", name: "客户二", agentId: null };
const CA: Auth = { userId: "ZZRV14CA", companyId: CO, role: "client", name: "代理的客户", agentId: null };
const AGENT: Auth = { userId: "zz_rv14_agent_login", companyId: CO, role: "agent", name: "代理", agentId: AGENT_ID };
const NO = (s: string) => `ZZRV14${s}`;
const CTR_NO = "ZZRVCTN0001"; // 本公司柜子表里的柜号（不是标准样子，只能靠「本公司柜号名单」抹）
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const beijingDay = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.log("⚠️ 跳过：没有 DATABASE_URL（CI 没有数据库）—— 这一项等于没测"); return; }
  if (!url.includes("neon.tech") && process.env.AGENT_PORTAL_TEST_ALLOW_DB !== "1") {
    console.log("⚠️ 跳过：DATABASE_URL 不是 Neon 测试库，怕连到生产库不跑（确认是测试库可设 AGENT_PORTAL_TEST_ALLOW_DB=1）—— 这一项等于没测");
    return;
  }
  process.env.NODE_ENV = process.env.NODE_ENV || "test";
  process.env.IMAGES_DIR = process.env.IMAGES_DIR || path.join(os.tmpdir(), "zz_rv14_images");
  const { prisma } = await import("../apps/api/src/db/prisma");
  const { BusinessError } = await import("../apps/api/src/modules/core/business-error");
  const pm: any = prisma;

  const routes = new Map<string, Function>();
  const app: any = {};
  for (const m of ["get", "post", "put", "patch", "delete"]) app[m] = (p: string, h: Function) => routes.set(`${m.toUpperCase()} ${p}`, h);
  (await import("../apps/api/src/modules/orders/routes")).registerOrderRoutes(app);
  (await import("../apps/api/src/modules/shipments/routes")).registerShipmentRoutes(app);
  (await import("../apps/api/src/modules/admin/routes")).registerAdminRoutes(app);
  (await import("../apps/api/src/modules/admin-ops/routes")).registerAdminOpsRoutes(app);
  (await import("../apps/api/src/modules/consolidation/routes")).registerConsolidationRoutes(app);
  (await import("../apps/api/src/modules/loading-manifests/routes")).registerLoadingManifestRoutes(app);
  (await import("../apps/api/src/modules/client-compliance/routes")).registerClientComplianceRoutes(app);
  (await import("../apps/api/src/modules/whr-consolidation/routes")).registerWhrConsolidationRoutes(app);
  (await import("../apps/api/src/modules/whr-consolidation/client-routes")).registerWhrConsolidationClientRoutes(app);
  (await import("../apps/api/src/modules/agent-portal/routes")).registerAgentPortalRoutes(app);
  (await import("../apps/api/src/modules/cs-chat/routes")).registerCsChatRoutes(app);

  /** 跟 server.ts 一样：BusinessError 按它的状态码回；别的异常 = 线上的 500（记成 status 500，不往外抛） */
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
  async function lockWaiters(): Promise<number> {
    const r = await pm.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    return r[0].n;
  }
  async function waitForWaiters(n: number): Promise<void> {
    for (let i = 0; i < 200; i++) { if ((await lockWaiters()) >= n) return; await sleepMs(25); }
    throw new Error(`等了 5 秒也没等到 ${n} 个请求卡在锁上`);
  }
  /** 另开一个事务锁住集货任务行，在锁里做 inLock，等 release() 才提交 —— 用来造「两个请求同时进来」 */
  function holdTaskLock(taskId: string, inLock: (tx: any) => Promise<void> = async () => {}): { ready: Promise<void>; release: () => void; done: Promise<void> } {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let markReady!: () => void;
    const ready = new Promise<void>((r) => { markReady = r; });
    const done = pm.$transaction(async (tx: any) => {
      await tx.$queryRaw`SELECT id FROM consolidation_tasks WHERE id = ${taskId} FOR UPDATE`;
      markReady();
      await gate;
      await inLock(tx);
    }, { timeout: 30000, maxWait: 10000 });
    return { ready, release, done };
  }

  const orderBody = (trackingNo: string, extra: Row = {}) => ({
    clientId: C1.userId, trackingNo, itemName: "灯具", packageCount: 10, weightKg: 100, volumeM3: 2,
    transportMode: "sea", warehouseId: "wh_yiwu_01", arrivedAt: beijingDay(), ...extra,
  });
  async function newOrder(trackingNo: string, extra: Row = {}): Promise<{ orderId: string; shipmentId: string }> {
    const d = await must("POST /staff/orders", STAFF, orderBody(trackingNo, extra));
    const s = await pm.shipment.findFirst({ where: { trackingNo }, select: { id: true } });
    return { orderId: d.orderId, shipmentId: s.id };
  }
  const product = (name: string) => ({ productName: name, packageCount: 1, quantityPerBox: 1, unitWeightKg: 1, lengthCm: 10, widthCm: 10, heightCm: 10, material: "布", cargoValue: "10", cargoType: "normal" });
  async function newTaskWithPrealert(client: Auth = C1): Promise<{ taskId: string; prealertId: string; rowIds: string[] }> {
    await must("POST /client/consolidation/tasks", client, { destinationTh: "曼谷" });
    const task = await pm.consolidationTask.findFirst({ where: { companyId: CO, clientId: client.userId }, orderBy: { createdAt: "desc" } });
    await must("POST /client/consolidation/prealerts", client, { taskId: task.id, mark: "M", products: [product("鞋")] });
    const pa = await pm.consolidationPrealert.findFirst({ where: { companyId: CO, taskId: task.id }, orderBy: { createdAt: "desc" } });
    const rows = await pm.consolidationPrealertProduct.findMany({ where: { prealertId: pa.id }, orderBy: { sortOrder: "asc" } });
    return { taskId: task.id, prealertId: pa.id, rowIds: rows.map((r: Row) => r.id) };
  }
  const prealertRows = async (prealertId: string) => (await pm.consolidationPrealertProduct.findMany({ where: { prealertId }, orderBy: { sortOrder: "asc" } })).map((r: Row) => r.productName);

  async function cleanup(): Promise<void> {
    await pm.csMessage.deleteMany({ where: { companyId: CO } });
    await pm.csConversation.deleteMany({ where: { companyId: CO } });
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
    await pm.consolidationStatusLog.deleteMany({ where: { companyId: CO } });
    const pas = await pm.consolidationPrealert.findMany({ where: { companyId: CO }, select: { id: true } });
    await pm.consolidationPrealertProduct.deleteMany({ where: { prealertId: { in: pas.map((p: Row) => p.id) } } });
    await pm.consolidationPrealert.deleteMany({ where: { companyId: CO } });
    await pm.consolidationTask.deleteMany({ where: { companyId: CO } });
    const plans = await pm.whrConsolidationPlan.findMany({ where: { companyId: CO }, select: { id: true } });
    const planIds = plans.map((p: Row) => p.id);
    await pm.whrConsolidationStatusLog.deleteMany({ where: { companyId: CO } });
    await pm.whrConsolidationPrealertItem.deleteMany({ where: { prealert: { planCustomer: { planId: { in: planIds } } } } });
    await pm.whrConsolidationPrealert.deleteMany({ where: { planCustomer: { planId: { in: planIds } } } });
    await pm.whrConsolidationPlanCustomer.deleteMany({ where: { planId: { in: planIds } } });
    await pm.whrConsolidationPlan.deleteMany({ where: { id: { in: planIds } } });
    await pm.consolidationBalanceLedger.deleteMany({ where: { companyId: CO } });
    await pm.walletRecharge.deleteMany({ where: { companyId: CO } });
    await pm.clientWalletAccount.deleteMany({ where: { companyId: CO } });
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
    await pm.agent.create({ data: { id: AGENT_ID, companyId: CO, name: "审查代理", priceNormal: 1, priceInspection: 1, priceSensitive: 1 } });
    for (const u of [ADMIN, ADMIN2, STAFF, C1, C2, CA, AGENT]) {
      await pm.user.create({ data: {
        id: u.userId, companyId: CO, role: u.role, name: u.name, passwordHash: "x", phone: `0${u.userId}`, status: "active",
        ...(u === CA || u === AGENT ? { agentId: AGENT_ID } : {}),
      } });
    }
    await pm.container.create({ data: { companyId: CO, containerNo: CTR_NO, containerType: "40HQ", currentStatus: "LOADING", transportMode: "sea" } });

    await check("R1 客户钱包流水：备注里员工手写的柜号（标准样子的、「柜号：」后面的、本公司柜子表里的）都抹掉，别的字和开头「管理员」的处理照旧", async () => {
      await pm.consolidationBalanceLedger.create({ data: {
        companyId: CO, clientId: C1.userId, type: "refund", amount: 10, balanceAfter: 10, refType: "whr", refNo: "WHRP0001",
        remark: `作废预报单退款（柜号：L2608219129，已满，改装 ${CTR_NO} 那柜，原来 MSKU1234565）`,
      } });
      await pm.consolidationBalanceLedger.create({ data: {
        companyId: CO, clientId: C1.userId, type: "refund", amount: 5, balanceAfter: 15, refType: "normal", refNo: "JH0000001",
        remark: "管理员撤销付款：柜号 MSKU7654321 不走了",
      } });
      const d = await must("GET /client/wallet/ledger", C1);
      const text = JSON.stringify(d.items.map((r: Row) => r.remark));
      for (const no of ["L2608219129", CTR_NO, "MSKU1234565", "MSKU7654321"]) assert.ok(!text.includes(no), `客户在钱包流水里看到了柜号 ${no}：${text}`);
      assert.ok(text.includes("作废预报单退款") && text.includes("不走了"), `别的字也被抹了：${text}`);
      assert.ok(!/"管理员/.test(text), `开头的「管理员」该照旧不给客户：${text}`);
      // 充值记录里管理员审核时手写的备注同一套（dsh 复核第 1 轮）
      await pm.walletRecharge.create({ data: {
        companyId: CO, clientId: C1.userId, currency: "CNY", amount: 100, paymentMethod: "WECHAT", proofImage: "x", status: "REJECTED",
        reviewRemark: `金额对不上，柜号：L2608219129，请重新上传`,
      } });
      const rc = await must("GET /client/wallet/recharges", C1);
      const rr = rc.recharges.map((r: Row) => r.reviewRemark).join(" | ");
      assert.ok(!rr.includes("L2608219129") && rr.includes("请重新上传"), `充值记录审核备注：${rr}`);
    });

    await check("R1b 代理仓库版柜详情：取消原因、状态记录里的柜号抹掉（代理页面关着，接口照样不许给）", async () => {
      const plan = await must("POST /admin/whr-consolidation/plans", ADMIN, {
        destinationTh: "曼谷", totalVolumeM3: 68,
        customers: [{ clientId: CA.userId, unitPriceNormal: 100, unitPriceInspection: 200, unitPriceSensitive: 300 }],
      });
      await must("POST /client/whr-consolidation/address", CA, { planId: plan.id, deliveryAddress: "曼谷" });
      const pa = await must("POST /client/whr-consolidation/prealerts", CA, { planId: plan.id, mark: "A1" });
      await must("POST /admin/whr-consolidation/prealerts/cancel", ADMIN, { planId: plan.id, prealertId: pa.id, cancelReason: `柜号：L2608219129，已满，改装 ${CTR_NO}` });
      const d = await must("GET /agent/whr/plan-detail", AGENT, {}, { planId: plan.id });
      const text = JSON.stringify(d);
      for (const no of ["L2608219129", CTR_NO]) assert.ok(!text.includes(no), `代理看到了柜号 ${no}`);
      const row = d.customers[0].prealerts.find((x: Row) => x.id === pa.id);
      assert.ok(row?.cancelReason?.includes("已满"), `取消原因整段没了（只该抹柜号）：${row?.cancelReason}`);
    });

    await check("R2 建派送单：货还在国内仓 / 正在卸柜 → 409、一车都不建、状态不动；在泰国仓的照常建", async () => {
      const ok1 = await newOrder(NO("LM1"));
      const ok2 = await newOrder(NO("LM2"));
      const cn = await newOrder(NO("LM3"));
      await pm.shipment.update({ where: { id: ok1.shipmentId }, data: { currentStatus: "inWarehouseTH" } });
      await pm.shipment.update({ where: { id: ok2.shipmentId }, data: { currentStatus: "inWarehouseTH" } });
      await pm.shipment.update({ where: { id: cn.shipmentId }, data: { currentStatus: "unloading" } });
      const lmBefore = await pm.adminLastmileOrder.count({ where: { companyId: CO } });
      const r = await call("POST /admin/lastmile/orders", STAFF, { shipmentIds: [ok1.shipmentId, cn.shipmentId], driverName: "司机", phoneNumber: "0800000000", deliveryDate: beijingDay() });
      assert.equal(r.status, 409, `还没到泰国仓的货也建成了派送单：${r.status} ${r.message}`);
      assert.match(r.message, new RegExp(`${NO("LM3")}.*不在泰国仓`));
      assert.equal(await pm.adminLastmileOrder.count({ where: { companyId: CO } }), lmBefore, "整车该一张都不建");
      assert.equal((await pm.shipment.findUnique({ where: { id: cn.shipmentId } })).currentStatus, "unloading", "卸柜中的货被改成了派送中");
      assert.equal((await pm.shipment.findUnique({ where: { id: ok1.shipmentId } })).currentStatus, "inWarehouseTH", "同车别的货也不该动");
      await pm.shipment.update({ where: { id: cn.shipmentId }, data: { currentStatus: "inWarehouseCN" } });
      const r2 = await call("POST /admin/lastmile/orders", STAFF, { shipmentIds: [cn.shipmentId] });
      assert.equal(r2.status, 409, "国内仓的货也该挡");
      const good = await call("POST /admin/lastmile/orders", STAFF, { shipmentIds: [ok1.shipmentId, ok2.shipmentId], driverName: "司机" });
      assert.equal(good.status, 200, good.message);
      assert.equal((await pm.shipment.findUnique({ where: { id: ok1.shipmentId } })).currentStatus, "outForDelivery");
      // 签收完再派一趟（已签收）照样放行（08-14 拍板）
      await pm.shipment.update({ where: { id: ok2.shipmentId }, data: { currentStatus: "delivered" } });
      await pm.adminLastmileOrder.updateMany({ where: { shipmentId: ok2.shipmentId }, data: { status: "SIGNED" } });
      const again = await call("POST /admin/lastmile/orders", STAFF, { shipmentIds: [ok2.shipmentId] });
      assert.equal(again.status, 200, `签收完再派一趟被挡了：${again.message}`);
    });

    await check("R3 普通版集货编辑：别人在我打开之后加的行，我拿旧页面保存 → 409、那行还在；我打开时就看得到的行，照样删得掉", async () => {
      const t = await newTaskWithPrealert();
      const [r1] = t.rowIds;
      // 同事 / 另一个窗口：加一行「帽」（他打开时只有 r1）
      await must("POST /client/consolidation/prealerts/update", C1, { prealertId: t.prealertId, mark: "M", products: [{ id: r1, ...product("鞋") }, product("帽")], baseProductIds: [r1] });
      assert.deepEqual(await prealertRows(t.prealertId), ["鞋", "帽"]);
      // 我：打开时只有 r1，改了鞋的件数保存
      const stale = await call("POST /client/consolidation/prealerts/update", C1, { prealertId: t.prealertId, mark: "M", products: [{ id: r1, ...product("鞋"), packageCount: 2 }], baseProductIds: [r1] });
      assert.equal(stale.status, 409, `别人刚加的行被我删了：${stale.status} ${stale.message}`);
      assert.match(stale.message, /有你页面上没有的货物行/);
      assert.deepEqual(await prealertRows(t.prealertId), ["鞋", "帽"], "那行没了 / 我的修改被存了一半");
      // 超管强制编辑同一个规矩
      const forced = await call("POST /admin/consolidation/prealerts/force-edit", ADMIN, { prealertId: t.prealertId, mark: "M", products: [{ id: r1, ...product("鞋") }], baseProductIds: [r1] });
      assert.equal(forced.status, 409, `强制编辑把别人刚加的行删了：${forced.message}`);
      // 刷新后（看得到两行）删掉帽：照常
      const rows = await pm.consolidationPrealertProduct.findMany({ where: { prealertId: t.prealertId } });
      const ok = await call("POST /client/consolidation/prealerts/update", C1, { prealertId: t.prealertId, mark: "M", products: [{ id: r1, ...product("鞋") }], baseProductIds: rows.map((r: Row) => r.id) });
      assert.equal(ok.status, 200, ok.message);
      assert.deepEqual(await prealertRows(t.prealertId), ["鞋"]);
      // 格式不对 400，不悄悄当没传；带 null 也算带了（Codex 第 8 轮：原来 null 被当成「老页面」，整道检查跳过）
      for (const baseProductIds of ["x", null, [1]]) {
        const bad = await call("POST /client/consolidation/prealerts/update", C1, { prealertId: t.prealertId, mark: "M", products: [{ id: r1, ...product("鞋") }], baseProductIds });
        assert.equal(bad.status, 400, `baseProductIds=${JSON.stringify(baseProductIds)} 没挡：${bad.status} ${bad.message}`);
        const badForce = await call("POST /admin/consolidation/prealerts/force-edit", ADMIN, { prealertId: t.prealertId, mark: "M", products: [{ id: r1, ...product("鞋") }], baseProductIds });
        assert.equal(badForce.status, 400, `强制编辑 baseProductIds=${JSON.stringify(baseProductIds)} 没挡`);
      }
      assert.deepEqual(await prealertRows(t.prealertId), ["鞋"]);
    });

    await check("R4 普通版集货：两个管理员同时删同一张预报单 → 一个 200、一个 404 人话（旧：500）", async () => {
      const t = await newTaskWithPrealert();
      const hold = holdTaskLock(t.taskId);
      await hold.ready;
      const a = call("POST /admin/consolidation/prealerts/delete", ADMIN, { prealertId: t.prealertId });
      const b = call("POST /admin/consolidation/prealerts/delete", ADMIN2, { prealertId: t.prealertId });
      await waitForWaiters(2);
      hold.release();
      await hold.done;
      const rs = await Promise.all([a, b]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 404], rs.map((r) => `${r.status} ${r.message}`).join(" / "));
      assert.match(rs.find((r) => r.status === 404)!.message, /刚刚已经被删掉了/);
    });

    await check("R4b 超管强制编辑保存的同一刻单子被删了 → 404 人话（旧：500 P2025）", async () => {
      const t = await newTaskWithPrealert();
      const hold = holdTaskLock(t.taskId, async (tx) => {
        await tx.consolidationPrealertProduct.deleteMany({ where: { prealertId: t.prealertId } });
        await tx.consolidationPrealert.delete({ where: { id: t.prealertId } });
      });
      await hold.ready;
      const edit = call("POST /admin/consolidation/prealerts/force-edit", ADMIN, { prealertId: t.prealertId, mark: "改个唛头" });
      const editNewRow = call("POST /admin/consolidation/prealerts/force-edit", ADMIN2, { prealertId: t.prealertId, mark: "M", products: [product("新加的")] });
      await waitForWaiters(2);
      hold.release();
      await hold.done;
      for (const r of await Promise.all([edit, editNewRow])) {
        assert.equal(r.status, 404, `${r.status} ${r.message}`);
        assert.match(r.message, /刚刚已经被删掉了/);
      }
    });

    await check("R5 普通版集货取消：点取消到拿到锁之间别人确认了满柜 → 记录写「已满柜 → 已取消」（旧：收集中 → 已取消）", async () => {
      const t = await newTaskWithPrealert();
      const hold = holdTaskLock(t.taskId, async (tx) => {
        await tx.consolidationTask.update({ where: { id: t.taskId }, data: { status: "full_confirmed" } });
      });
      await hold.ready;
      const cancel = call("POST /staff/consolidation/tasks/cancel", STAFF, { taskId: t.taskId });
      await waitForWaiters(1);
      hold.release();
      await hold.done;
      const r = await cancel;
      assert.equal(r.status, 200, r.message);
      const log = await pm.consolidationStatusLog.findFirst({ where: { taskId: t.taskId, toStatus: "cancelled" } });
      assert.equal(log?.fromStatus, "full_confirmed", `记录里的原状态：${log?.fromStatus}`);
    });

    await check("R6 员工建单：仓库 / 运输方式 / 包装单位填中文 → 400 不存（旧：原样存进库）；内部值照常", async () => {
      for (const [extra, field] of [[{ transportMode: "陆运" }, "运输方式"], [{ warehouseId: "义乌仓" }, "仓库"], [{ packageUnit: "袋" }, "包装单位"]] as Array<[Row, string]>) {
        const no = NO(`ENUM${field.length}${Object.keys(extra)[0]}`);
        const r = await call("POST /staff/orders", STAFF, orderBody(no, extra));
        assert.equal(r.status, 400, `${field}填中文照样建成了：${r.message}`);
        assert.match(r.message, new RegExp(field));
        assert.equal(await pm.shipment.count({ where: { trackingNo: no } }), 0);
      }
      const ok = await call("POST /staff/orders", STAFF, orderBody(NO("ENUMOK"), { transportMode: "land", packageUnit: "bag", warehouseId: "wh_shenzhen_01" }));
      assert.equal(ok.status, 200, ok.message);
    });

    await check("R6b 客户建预报单 / 员工确认收货：运输方式、包装单位不认识 → 400", async () => {
      const bad1 = await call("POST /client/prealerts", C1, { warehouseId: "wh_yiwu_01", itemName: "灯", packageCount: 2, transportMode: "陆运" });
      assert.equal(bad1.status, 400, bad1.message);
      assert.match(bad1.message, /运输方式只能选海运或陆运/);
      const bad2 = await call("POST /client/prealerts", C1, { warehouseId: "wh_yiwu_01", itemName: "灯", packageCount: 2, transportMode: "sea", packageUnit: "袋" });
      assert.equal(bad2.status, 400, bad2.message);
      assert.match(bad2.message, /包装单位只能选箱或袋/);
      const pa = await must("POST /client/prealerts", C1, { warehouseId: "wh_yiwu_01", itemName: "灯", packageCount: 2, transportMode: "land", packageUnit: "bag" });
      const orderId = pa.orderId ?? pa.id ?? (await pm.order.findFirst({ where: { companyId: CO, clientId: C1.userId }, orderBy: { createdAt: "desc" } })).id;
      const bad3 = await call("POST /staff/prealerts/receive", STAFF, { orderId, packageCount: 2, transportMode: "海运" });
      assert.equal(bad3.status, 400, bad3.message);
      assert.match(bad3.message, /运输方式只能选海运或陆运/, "确认收货应该是被运输方式那道挡下的");
    });

    await check("R7 客户建预报单：发货日期 2026-02-31 / 2026 / 2026-13-01 → 400（旧：前两个原文存进库）；2026-02-28 照常", async () => {
      for (const d of ["2026-02-31", "2026", "2026-13-01", "2026/10/14"]) {
        const r = await call("POST /client/prealerts", C1, { warehouseId: "wh_yiwu_01", itemName: "灯", packageCount: 2, transportMode: "sea", shipDate: d });
        assert.equal(r.status, 400, `发货日期「${d}」照样建成了`);
        assert.match(r.message, /不是有效日期/);
      }
      // 不是文字的：400，不是 500（Codex 第 10 轮），也不建单
      const before = await pm.order.count({ where: { companyId: CO } });
      for (const d of [123, {}, [], true]) {
        const r = await call("POST /client/prealerts", C1, { warehouseId: "wh_yiwu_01", itemName: "灯", packageCount: 2, transportMode: "sea", shipDate: d });
        assert.equal(r.status, 400, `发货日期=${JSON.stringify(d)}：${r.status} ${r.message}`);
      }
      assert.equal(await pm.order.count({ where: { companyId: CO } }), before, "日期格式不对还建了单");
      await must("POST /client/prealerts", C1, { warehouseId: "wh_yiwu_01", itemName: "灯", packageCount: 2, transportMode: "sea", shipDate: "2026-02-28" });
      await must("POST /client/prealerts", C1, { warehouseId: "wh_yiwu_01", itemName: "灯", packageCount: 2, transportMode: "sea", shipDate: null });
    });

    await check("R8 确认收货改国内单号：订单、运单、唯一那行产品一起改（旧：只改订单）", async () => {
      await must("POST /client/prealerts", C1, { warehouseId: "wh_yiwu_01", transportMode: "sea", products: [{ itemName: "杯子", packageCount: 4, domesticTrackingNo: "SFOLD001" }] });
      const order = await pm.order.findFirst({ where: { companyId: CO, clientId: C1.userId }, orderBy: { createdAt: "desc" } });
      await must("POST /staff/prealerts/receive", STAFF, { orderId: order.id, packageCount: 4, domesticTrackingNo: "  SFNEW002 ", domesticTrackingNoEdited: true });
      const o = await pm.order.findUnique({ where: { id: order.id } });
      const s = await pm.shipment.findFirst({ where: { orderId: order.id, parentTrackingNo: null } });
      const p = await pm.orderProduct.findMany({ where: { orderId: order.id } });
      assert.deepEqual([o.domesticTrackingNo, s.domesticTrackingNo, p.map((x: Row) => x.domesticTrackingNo)], ["SFNEW002", "SFNEW002", ["SFNEW002"]]);
      // 不传（员工没改）就都不动
      await must("POST /client/prealerts", C1, { warehouseId: "wh_yiwu_01", transportMode: "sea", products: [{ itemName: "碗", packageCount: 3, domesticTrackingNo: "SFKEEP003" }] });
      const order2 = await pm.order.findFirst({ where: { companyId: CO, clientId: C1.userId }, orderBy: { createdAt: "desc" } });
      const before = await pm.shipment.findFirst({ where: { orderId: order2.id, parentTrackingNo: null } });
      await must("POST /staff/prealerts/receive", STAFF, { orderId: order2.id, packageCount: 3 });
      const after = await pm.shipment.findFirst({ where: { orderId: order2.id, parentTrackingNo: null } });
      assert.equal(after.domesticTrackingNo, before.domesticTrackingNo, "没传国内单号，运单上的号被改了");
      assert.deepEqual((await pm.orderProduct.findMany({ where: { orderId: order2.id } })).map((x: Row) => x.domesticTrackingNo), ["SFKEEP003"]);
      // 上线那一刻还开着的老页面：不带「员工真改过」标记、照发默认的「货拉拉」—— 只改订单那一格（跟原来一样），运单、产品行不动（Codex 第 4 轮）
      await must("POST /client/prealerts", C1, { warehouseId: "wh_yiwu_01", transportMode: "sea", domesticTrackingNo: "SFREAL004", products: [{ itemName: "盘", packageCount: 2 }] });
      const order3 = await pm.order.findFirst({ where: { companyId: CO, clientId: C1.userId }, orderBy: { createdAt: "desc" } });
      await must("POST /staff/prealerts/receive", STAFF, { orderId: order3.id, packageCount: 2, domesticTrackingNo: "货拉拉" });
      const s3 = await pm.shipment.findFirst({ where: { orderId: order3.id, parentTrackingNo: null } });
      assert.equal(s3.domesticTrackingNo, "SFREAL004", "老页面发来的「货拉拉」把运单上的真号盖掉了");
    });

    let loadedParentNo = "";
    await check("R9 超管首页「今日收货体积」：今天进仓的货当天整票装柜，数不往下掉（旧：装走就算 0）", async () => {
      const before = (await must("GET /admin/dashboard/overview", ADMIN)).receivedVolumeM3Today;
      loadedParentNo = NO("VOL1");
      await newOrder(loadedParentNo, { volumeM3: 2.5, packageCount: 5 });
      const mid = (await must("GET /admin/dashboard/overview", ADMIN)).receivedVolumeM3Today;
      assert.equal(Number((mid - before).toFixed(3)), 2.5, `建单后应多 2.5 方：${before} → ${mid}`);
      const ctr = (await must("POST /staff/loading-manifests", STAFF, { warehouse: "wh_yiwu_01", transportMode: "sea" })).manifest.id;
      await must("POST /staff/loading-manifests/add-shipment", STAFF, { trackingNo: loadedParentNo, pieceCount: 5 }, { id: ctr });
      assert.equal(Number((await pm.shipment.findFirst({ where: { trackingNo: loadedParentNo } })).volumeM3), 0, "（前提）整票装走后父单剩 0");
      const after = (await must("GET /admin/dashboard/overview", ADMIN)).receivedVolumeM3Today;
      assert.equal(after, mid, `当天装柜后今日收货体积变了：${mid} → ${after}`);
    });

    await check("R10 装柜「可选运单」映射：带子单号、父单号、件数，页面能按父单归拢（旧：只有子单 id）", async () => {
      const d = await must("GET /staff/loading-manifests/shipment-map", STAFF);
      const row = d.items.find((x: Row) => x.parentTrackingNo === loadedParentNo);
      assert.ok(row, `找不到 ${loadedParentNo} 的子单：${JSON.stringify(d.items.slice(0, 3))}`);
      assert.equal(row.trackingNo, `${loadedParentNo}-1`);
      assert.equal(row.packageCount, 5);
      assert.ok(row.manifestNo);
    });

    await check("R11 客户按运单 id 找自己的这一票：改过号也找得到；别人的 id 一条都没有", async () => {
      const { orderId, shipmentId } = await newOrder(NO("REF1"));
      await pm.order.update({ where: { id: orderId }, data: { approvalStatus: "approved" } });
      await pm.shipment.update({ where: { id: shipmentId }, data: { trackingNo: NO("REF1NEW") } });
      const mine = await must("GET /client/orders", C1, {}, { shipmentId, pageSize: "5" });
      assert.equal(mine.supportsShipmentIdQuery, true, "后端没明说认按运单 id 找");
      assert.deepEqual(mine.items.map((x: Row) => [x.shipmentId, x.trackingNo]), [[shipmentId, NO("REF1NEW")]]);
      const other = await must("GET /client/orders", C2, {}, { shipmentId, pageSize: "5" });
      assert.equal(other.items.length, 0, "别的客户按 id 找到了这票");
      assert.equal(other.total, 0);
    });

    await check("R12 客服对话：整柜卡片显示现在的提单号（旧：一直是发消息那一刻的号）；运单卡片照旧", async () => {
      const { orderId, shipmentId } = await newOrder(NO("FCL1"));
      await pm.order.update({ where: { id: orderId }, data: { approvalStatus: "approved" } });
      const fcl = await pm.container.create({ data: { companyId: CO, containerNo: "ZZRVFCL0001", containerType: "40HQ", currentStatus: "LOADING", transportMode: "sea", isFcl: true } });
      await pm.shipmentContainerItem.create({ data: { containerId: fcl.id, shipmentId, loadedPieceCount: 10, loadedVolumeM3: 2 } });
      await must("POST /client/chat/send", C1, { content: "这柜到哪了", ref: { type: "fcl", id: fcl.id } });
      await pm.shipment.update({ where: { id: shipmentId }, data: { trackingNo: NO("FCL1NEW") } });
      const msgs = await must("GET /client/chat/messages", C1);
      const m = msgs.messages.find((x: Row) => x.ref?.type === "fcl");
      assert.equal(m?.ref?.no, NO("FCL1NEW"), `整柜卡片还是旧号：${m?.ref?.no}`);
      const staffView = await must("GET /staff/chat/messages", STAFF, {}, { clientId: C1.userId });
      assert.equal(staffView.messages.find((x: Row) => x.ref?.type === "fcl")?.ref?.no, NO("FCL1NEW"));
    });

    await check("R13 装柜单号不填柜号自动编：按北京日期（旧：按服务器时区，北京 0～8 点建的是前一天）", async () => {
      const dayBefore = beijingDay();
      const m = (await must("POST /staff/loading-manifests", STAFF, { warehouse: "wh_yiwu_01", transportMode: "sea" })).manifest;
      const dayAfter = beijingDay();
      const keys = [dayBefore, dayAfter].map((d) => `CN-TH-${d.replace(/-/g, "")}`);
      assert.ok(typeof m.manifestNo === "string" && keys.some((k) => m.manifestNo.startsWith(k)), `柜号 ${m.manifestNo} 不是北京今天（${keys.join(" / ")}）`);
    });
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
  console.log(`\n${passed} 项通过，${failed} 项失败`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
